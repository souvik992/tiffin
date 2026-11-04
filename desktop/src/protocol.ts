// How the desktop window's private scheme maps to files and to the backend. Pure functions (no Electron), so they are unit-tested.
// The window loads app://pos/index.html. Same origin for the UI and /api: no CORS, and the UI build is unchanged
// (it calls relative /api paths, exactly as behind the Vite dev proxy).
import { extname, isAbsolute, join, normalize, relative } from 'node:path';

export const SCHEME = 'app';
export const HOST = 'pos';
export const START_URL = `${SCHEME}://${HOST}/index.html`;

export type Resolved =
  | { kind: 'api'; path: string }
  | { kind: 'file'; file: string; type: string }
  | { kind: 'missing' };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

/** Maps a request URL to a backend API path or a file inside uiDir. Anything outside uiDir, or another host, is "missing". */
export function resolveRequest(rawUrl: string, uiDir: string, host: string = HOST): Resolved {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { kind: 'missing' }; }
  if (url.protocol !== `${SCHEME}:` || url.host !== host) return { kind: 'missing' };
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return { kind: 'api', path: url.pathname + url.search };
  let p: string;
  try { p = decodeURIComponent(url.pathname); } catch { return { kind: 'missing' }; }
  if (p.includes('\0')) return { kind: 'missing' };
  if (p === '/' || p === '') p = '/index.html';
  const file = normalize(join(uiDir, p));
  const rel = relative(uiDir, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { kind: 'missing' }; // path traversal
  return { kind: 'file', file, type: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' };
}

/** Only the app's own scripts run; images may be data:/blob: (menu photos, downloads); nothing is loaded from the internet. */
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

/** Request headers forwarded to the backend: the renderer's own copy of the secret header (if any) is dropped and the real one added. */
export function forwardHeaders(incoming: Iterable<[string, string]>, secret: string): Headers {
  const h = new Headers();
  for (const [k, v] of incoming) {
    const key = k.toLowerCase();
    if (key === 'x-pos-secret' || key === 'host' || key === 'connection' || key === 'content-length') continue;
    h.set(k, v);
  }
  h.set('x-pos-secret', secret);
  return h;
}

/** Whether the window may navigate to a URL: only inside the app. */
export const isAppUrl = (u: string, host: string = HOST): boolean => { try { const x = new URL(u); return x.protocol === `${SCHEME}:` && x.host === host; } catch { return false; } };
