// Electron main process: one window, the backend in a utility process, the UI served on app://pos.
// Security: the page has no Node access (contextIsolation, sandbox, no preload), may not navigate or open windows,
// gets no permissions, and its only way to the backend is /api on its own origin, which this process forwards with a secret.
import { app, BrowserWindow, dialog, Menu, protocol, session, shell, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { CSP, SCHEME, START_URL, forwardHeaders, isAppUrl, resolveRequest } from './protocol.ts';
import { startUpdates } from './updates.ts';

const PRODUCT = 'Tiffin POS';
// Local (not roaming) AppData: the database must never sync across a domain profile. Kept on uninstall.
const home = process.env.POS_HOME ?? join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'TiffinPOS'); // POS_HOME: tests use a temporary folder
app.setPath('userData', join(home, 'electron'));
const dataDir = process.env.POS_DATA_DIR ?? join(home, 'data');
/** Signed add-ons (e.g. ODS), installed by their own installer next to the POS. */
const addonsDir = join(home, 'addons');
const logDir = join(home, 'logs');
mkdirSync(dataDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
mkdirSync(addonsDir, { recursive: true });
const uiDir = join(__dirname, 'ui');

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// ---------------------------------------------------------------- logging (rotates at 5 MB, one old file kept)
const logFile = join(logDir, 'pos.log');
function log(line: string) {
  try {
    try { if (statSync(logFile).size > 5_000_000) renameSync(logFile, `${logFile}.1`); } catch { /* first run */ }
    appendFileSync(logFile, `${new Date().toISOString()} ${line.trimEnd()}\n`);
  } catch { /* logging must never stop billing */ }
}

// ---------------------------------------------------------------- one copy only (two copies on one database is unsafe)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  void app.whenReady().then(start);
}

let win: BrowserWindow | null = null;
let backend: UtilityProcess | null = null;
let port = 0;
const secret = randomBytes(32).toString('hex');
let quitting = false;
let restarts = 0;

function startBackendProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'backend.cjs'), [], {
      serviceName: `${PRODUCT} backend`, stdio: 'pipe',
      env: { ...process.env, POS_DATA_DIR: dataDir, POS_LAUNCH_SECRET: secret, POS_ADDONS_DIR: addonsDir, POS_APP_VERSION: app.getVersion() },
    });
    backend = child;
    child.stdout?.on('data', (d: Buffer) => log(`[backend] ${d.toString()}`));
    child.stderr?.on('data', (d: Buffer) => log(`[backend:err] ${d.toString()}`));
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('The billing service did not start within 60 seconds.')); child.kill(); } }, 60_000);
    child.on('message', (m: { type: string; port?: number; code?: string; message?: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (m.type === 'ready' && m.port) { port = m.port; resolve(m.port); } else reject(Object.assign(new Error(m.message ?? 'The billing service failed to start.'), { code: m.code }));
    });
    child.on('exit', (code) => {
      log(`backend exited with code ${code}`);
      if (backend === child) backend = null;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`The billing service stopped while starting (code ${code}).`)); return; }
      if (!quitting) void onBackendCrash(code);
    });
  });
}

async function onBackendCrash(code: number) {
  // Bills already saved are safe (every bill is committed before it is shown). Restart a few times, then ask.
  if (restarts < 3) {
    restarts++;
    log(`restarting backend (attempt ${restarts})`);
    try { await startBackendProcess(); win?.webContents.reload(); return; } catch (e) { log(`restart failed: ${String(e)}`); }
  }
  const r = await dialog.showMessageBox({ type: 'error', title: PRODUCT, message: 'The billing service stopped.', detail: `Saved bills are safe. Try again, or close the POS and open it again. (code ${code}) Log: ${logFile}`, buttons: ['Try again', 'Close POS'], defaultId: 0, noLink: true });
  if (r.response === 0) { restarts = 0; void onBackendCrash(code); } else app.quit();
}

async function serve(req: Request): Promise<Response> {
  const r = resolveRequest(req.url, uiDir);
  if (r.kind === 'api') {
    if (!port) return Response.json({ error: { code: 'NETWORK', message: 'The billing service is starting. Try again in a moment.' } }, { status: 503 });
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    // Node's fetch (not Chromium's), so a system proxy never sees bills; streams (live events) pass straight through.
    return fetch(`http://127.0.0.1:${port}${r.path}`, {
      method: req.method, headers: forwardHeaders(req.headers, secret), body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual',
    }).catch(() => Response.json({ error: { code: 'NETWORK', message: 'Cannot reach the billing service.' } }, { status: 503 }));
  }
  if (r.kind === 'file') {
    try {
      return new Response(readFileSync(r.file), { headers: { 'Content-Type': r.type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' } });
    } catch { /* fall through */ }
  }
  return new Response('Not found', { status: 404 });
}

function lockDown() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (_e, item) => item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) }));
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
    wc.on('will-redirect', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url); // e.g. a help link opens in the normal browser
      return { action: 'deny' };
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    title: PRODUCT, width: 1366, height: 820, minWidth: 1024, minHeight: 640, show: false, backgroundColor: '#f6f2ec',
    icon: join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false, devTools: !app.isPackaged, autoplayPolicy: 'no-user-gesture-required' }, // the online-order buzzer must ring without a tap first
  });
  win.once('ready-to-show', () => { win?.maximize(); win?.show(); });
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}); // no accidental pinch zoom on touch screens
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { e.preventDefault(); win?.setFullScreen(!win.isFullScreen()); }
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') win?.webContents.toggleDevTools();
  });
  win.webContents.on('render-process-gone', (_e, d) => { log(`window crashed: ${d.reason}`); if (!quitting) win?.webContents.reload(); });
  win.on('closed', () => { win = null; });
  // Windows sign-out or shutdown: ask the backend to close cleanly (bills are already safe; this adds the closing backup).
  win.on('session-end', () => { quitting = true; backend?.postMessage({ type: 'shutdown' }); });
  void win.loadURL(START_URL);
}

async function start() {
  Menu.setApplicationMenu(null);
  lockDown();
  protocol.handle(SCHEME, serve);
  log(`starting ${PRODUCT} ${app.getVersion()} data=${dataDir}`);
  try {
    await startBackendProcess();
  } catch (e) {
    const err = e as Error & { code?: string };
    log(`backend failed to start: ${err.code ?? ''} ${err.message}`);
    const r = await dialog.showMessageBox({
      type: 'error', title: PRODUCT, message: 'The POS could not start.', noLink: true,
      detail: `${err.message}\n\nYour data is in ${dataDir}. Backups are in its "backups" folder.`, buttons: ['Open data folder', 'Close'], defaultId: 1,
    });
    if (r.response === 0) await shell.openPath(dataDir);
    app.exit(1);
    return;
  }
  createWindow();
  watchAddons();
  startUpdates(log);
}

/** An add-on was installed, updated or removed while the POS runs: offer a restart (never forced: a bill may be open). */
function watchAddons() {
  let timer: NodeJS.Timeout | null = null, asking = false;
  try {
    watch(addonsDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (asking || quitting) return;
        asking = true;
        log('add-ons changed on disk');
        const r = await dialog.showMessageBox({ type: 'info', title: PRODUCT, message: 'An add-on was installed or updated.', detail: 'Restart the POS to use it. Finish any open bill first.', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, noLink: true });
        asking = false;
        if (r.response === 0) { app.relaunch(); app.quit(); }
      }, 2000);
    });
  } catch (e) { log(`cannot watch add-ons: ${String(e)}`); }
}

// Closing: stop the backend cleanly (it finishes the print queue step and takes a closing backup), then exit.
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (quitting || !backend) return;
  e.preventDefault();
  quitting = true;
  const child = backend;
  const done = () => app.quit();
  child.once('exit', done);
  setTimeout(() => { log('backend did not stop in 20 s; closing anyway'); child.kill(); done(); }, 20_000).unref();
  child.postMessage({ type: 'shutdown' });
});

