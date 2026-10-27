// Tiffin Data Manager (a separate app and installer from the POS): the shop's data for the owner. Same lockdown as the
// POS window (desktop/src/main.ts): no Node in the page, no navigation away, no permissions, and its only way to the
// data is /api and /mgr on its own origin (app://manager), which this process forwards with a per-launch secret.
import { app, BrowserWindow, dialog, Menu, protocol, session, shell, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CSP, SCHEME, forwardHeaders, isAppUrl, resolveRequest } from '../protocol.ts';

const PRODUCT = 'Tiffin Data Manager';
const HOST = 'manager';
const START_URL = `${SCHEME}://${HOST}/manager.html`;
const local = process.env.LOCALAPPDATA ?? app.getPath('appData');
// This app's own folder (its window profile, log and temporary copies). Never inside the POS's folder.
const home = process.env.MANAGER_HOME ?? join(local, 'TiffinDataManager');
// The POS's data on this computer (kept there when the POS is uninstalled). Read where it is; never created here.
const posDataDir = process.env.POS_DATA_DIR ?? join(process.env.POS_HOME ?? join(local, 'TiffinPOS'), 'data');
app.setPath('userData', join(home, 'electron'));
const logDir = join(home, 'logs');
mkdirSync(logDir, { recursive: true });
const uiDir = join(__dirname, 'ui');

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const logFile = join(logDir, 'manager.log');
function log(line: string) {
  try {
    try { if (statSync(logFile).size > 5_000_000) renameSync(logFile, `${logFile}.1`); } catch { /* first run */ }
    appendFileSync(logFile, `${new Date().toISOString()} ${line.trimEnd()}\n`);
  } catch { /* never stops the app */ }
}

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

function startBackendProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(__dirname, 'backend.cjs'), [], {
      serviceName: `${PRODUCT} backend`, stdio: 'pipe',
      env: { ...process.env, MANAGER_HOME: home, POS_DATA_DIR: posDataDir, MANAGER_LAUNCH_SECRET: secret },
    });
    backend = child;
    child.stdout?.on('data', (d: Buffer) => log(`[backend] ${d.toString()}`));
    child.stderr?.on('data', (d: Buffer) => log(`[backend:err] ${d.toString()}`));
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Tiffin Data Manager did not start within 60 seconds.')); child.kill(); } }, 60_000);
    child.on('message', (m: { type: string; port?: number; message?: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (m.type === 'ready' && m.port) { port = m.port; resolve(m.port); } else reject(new Error(m.message ?? 'Tiffin Data Manager failed to start.'));
    });
    child.on('exit', (code) => {
      log(`backend exited with code ${code}`);
      if (backend === child) backend = null;
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Tiffin Data Manager stopped while starting (code ${code}).`)); return; }
      if (!quitting) {
        // nothing is lost (it only reads, or saves each change at once): start again and reload
        void startBackendProcess().then(() => win?.webContents.reload()).catch((e) => { log(`restart failed: ${String(e)}`); app.quit(); });
      }
    });
  });
}

async function pick(kind: 'folder' | 'file'): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = kind === 'folder'
    ? { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] }
    : { title: 'Choose a Tiffin POS backup file', properties: ['openFile'], filters: [{ name: 'Tiffin POS backup', extensions: ['db'] }] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? null : r.filePaths[0] ?? null;
}

async function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  if (req.method === 'POST' && (url.pathname === '/__desktop/choose-folder' || url.pathname === '/__desktop/choose-file')) {
    return Response.json({ path: await pick(url.pathname.endsWith('folder') ? 'folder' : 'file') });
  }
  const toBackend = url.pathname.startsWith('/mgr/') || url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (toBackend) {
    if (!port) return Response.json({ error: { code: 'NETWORK', message: 'Tiffin Data Manager is starting. Try again in a moment.' } }, { status: 503 });
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: req.method, headers: forwardHeaders(req.headers, secret), body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual',
    }).catch(() => Response.json({ error: { code: 'NETWORK', message: 'Tiffin Data Manager is not responding.' } }, { status: 503 }));
  }
  const r = resolveRequest(req.url, uiDir, HOST);
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
    wc.on('will-navigate', (e, u) => { if (!isAppUrl(u, HOST)) e.preventDefault(); });
    wc.on('will-redirect', (e, u) => { if (!isAppUrl(u, HOST)) e.preventDefault(); });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  });
}

function createWindow() {
  win = new BrowserWindow({
    title: PRODUCT, width: 1366, height: 820, minWidth: 1024, minHeight: 640, show: false, backgroundColor: '#f6f2ec',
    icon: join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false, devTools: !app.isPackaged },
  });
  win.once('ready-to-show', () => { win?.maximize(); win?.show(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { e.preventDefault(); win?.setFullScreen(!win.isFullScreen()); }
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') win?.webContents.toggleDevTools();
  });
  win.webContents.on('render-process-gone', (_e, d) => { log(`window crashed: ${d.reason}`); if (!quitting) win?.webContents.reload(); });
  win.on('closed', () => { win = null; });
  void win.loadURL(START_URL);
}

async function start() {
  Menu.setApplicationMenu(null);
  lockDown();
  protocol.handle(SCHEME, serve);
  log(`starting ${PRODUCT} ${app.getVersion()} posData=${posDataDir}`);
  try { await startBackendProcess(); } catch (e) {
    log(`backend failed to start: ${String((e as Error).message)}`);
    await dialog.showMessageBox({ type: 'error', title: PRODUCT, message: 'Tiffin Data Manager could not start.', detail: `${(e as Error).message}\n\nLog: ${logFile}`, buttons: ['Close'], noLink: true });
    app.exit(1);
    return;
  }
  createWindow();
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (quitting || !backend) return;
  e.preventDefault();
  quitting = true;
  const child = backend;
  const done = () => app.quit();
  child.once('exit', done);
  setTimeout(() => { child.kill(); done(); }, 10_000).unref();
  child.postMessage({ type: 'shutdown' });
});
