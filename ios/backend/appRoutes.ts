// What the iPhone/iPad app's gatekeeper (android/backend/front.ts) adds: Settings > This device > Add-ons. The page picks
// the .tiffinaddon file itself (the iOS file picker) and posts its bytes here; it is unpacked with the desktop app's code
// (desktop/src/addonFile.ts). As on Windows, the POS checks the signature, every file's fingerprint and the version when
// it starts, and only the owner may install or remove (asked of the backend with the page's own sign-in). Then the POS
// restarts in place (iOS cannot start the app's Node again), so the add-on is in use straight away.
import http from 'node:http';
import { installAddon, readAddonFile, removeAddon } from '../../desktop/src/addonFile.ts';
import type { AppRoutes } from '../../android/backend/front.ts';

const MAX_UPLOAD = 31 * 1024 * 1024; // the add-on reader allows 30 MB

export interface IosRoutesOptions {
  addonsDir: string; backendPort: number; secret: string; log?: (line: string) => void;
  /** Restarts the POS in place so it loads the add-ons again (called after the answer is sent). */
  restart?: (reason: string) => Promise<void>;
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
const fail = (res: http.ServerResponse, message: string, status = 400) => reply(res, status, { error: { code: 'ADDON', message } });

function isOwner(o: IosRoutesOptions, authorization: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (!authorization) { resolve(false); return; }
    const req = http.request({ host: '127.0.0.1', port: o.backendPort, path: '/api/me', headers: { authorization, 'x-pos-secret': o.secret, host: `127.0.0.1:${o.backendPort}` } }, (r) => {
      let text = ''; r.setEncoding('utf8'); r.on('data', (c: string) => { text += c; });
      r.on('end', () => { try { resolve(r.statusCode === 200 && (JSON.parse(text) as { role?: string }).role === 'owner'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_UPLOAD) { resolve(null); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export function iosAppRoutes(o: IosRoutesOptions): AppRoutes {
  const log = o.log ?? (() => {});
  return (req, res, url) => {
    if (url.pathname !== '/__ios/install-addon' && url.pathname !== '/__ios/remove-addon') return false;
    if (req.method !== 'POST') { fail(res, 'Method not allowed.', 405); return true; }
    void (async () => {
      const body = url.pathname === '/__ios/install-addon' ? await readBody(req) : Buffer.alloc(0);
      if (!(await isOwner(o, req.headers.authorization))) return fail(res, url.pathname === '/__ios/install-addon' ? 'Only the owner can install add-ons.' : 'Only the owner can remove add-ons.', 403);
      if (url.pathname === '/__ios/remove-addon') {
        const id = url.searchParams.get('id') ?? '';
        if (!removeAddon(o.addonsDir, id)) return fail(res, 'That add-on is not installed.', 404);
        log(`add-on removed: ${id}`);
        reply(res, 200, { removed: id });
        return void o.restart?.('add-on removed');
      }
      if (!body) return fail(res, 'The add-on file is too large.');
      try {
        const a = readAddonFile(body);
        installAddon(o.addonsDir, a);
        log(`add-on installed from file: ${a.id} ${a.version}`);
        reply(res, 200, { installed: { id: a.id, name: a.name, version: a.version } });
        return void o.restart?.('add-on installed');
      } catch (e) {
        return fail(res, e instanceof Error ? e.message : 'The add-on could not be installed.');
      }
    })();
    return true;
  };
}
