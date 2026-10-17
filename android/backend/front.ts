// The Android app's gatekeeper, inside the same Node process as the POS backend. The app's window loads
// http://127.0.0.1:<port>/: this serves the UI files and forwards /api to the backend with the launch secret, like the
// desktop app's app:// protocol (desktop/src/protocol.ts). Other apps on the device can reach loopback ports too, so every
// request must carry the app's private cookie (set by the app in its own WebView cookie jar, never readable by others).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export interface FrontOptions { uiDir: string; backendPort: number; secret: string; token: string; port?: number }
export interface Front { port: number; close(): Promise<void> }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
/** Same rules as the desktop window: only the app's own files and API; nothing from the internet. */
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
const COOKIE = 'pos_k';

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const cookieOf = (raw: string | undefined) => (raw ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';

/** The file inside uiDir for a path, or null (outside the folder, or a bad path). */
export function uiFile(uiDir: string, pathname: string): string | null {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\0')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const file = normalize(join(uiDir, p));
  const rel = relative(uiDir, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return file;
}

export async function startFront(o: FrontOptions): Promise<Front> {
  if (o.token.length < 32) throw new Error('the app token is too short');
  const server = http.createServer((req, res) => {
    const deny = (status: number, text: string) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); } res.end(text); };
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return deny(403, 'Unexpected Host header.');
    if (!same(cookieOf(req.headers.cookie), o.token)) return deny(403, 'Open Tiffin POS from its app.');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!['cookie', 'x-pos-secret', 'host', 'connection'].includes(k)) headers[k] = v;
      headers['x-pos-secret'] = o.secret;
      headers.host = `127.0.0.1:${o.backendPort}`;
      const up = http.request({ host: '127.0.0.1', port: o.backendPort, method: req.method, path: url.pathname + url.search, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res); // streams too (live feeds)
      });
      up.on('error', () => deny(502, 'The POS is starting. Try again in a moment.'));
      req.on('aborted', () => up.destroy());
      req.pipe(up);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'Method not allowed.');
    const file = uiFile(o.uiDir, url.pathname);
    if (!file) return deny(404, 'Not found.');
    void (async () => {
      try {
        if (!(await stat(file)).isFile()) return deny(404, 'Not found.');
        const body = await readFile(file);
        const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': type.startsWith('text/html') ? 'no-cache' : 'max-age=31536000, immutable' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch { deny(404, 'Not found.'); }
    })();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  return { port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
