import { ApiError } from '../lib/api.ts';
import { currentToken } from '../lib/session.tsx';

// Tiffin Data Manager's own routes (/mgr/...). The shared screens use the POS API (/api/...) as usual.

export interface Status {
  source: null | {
    kind: 'live' | 'snapshot'; origin: 'data' | 'folder' | 'file'; path: string; store: string | null;
    schema: number; appSchema: number; editable: boolean; viewOnly: string | null;
  };
  error: { code: string; message: string } | null;
  posRunning: boolean;
  dataDir: string;
  signedIn: boolean;
}
export interface TableInfo { name: string; kind: 'table' | 'view'; rows: number }
export interface TablePage { name: string; kind: string; columns: string[]; total: number; offset: number; limit: number; rows: Array<Array<string | number | null>> }
export interface BackupFile { file: string; bytes: number; kind: string; at: number }
export interface Backups { folder: string | null; files: BackupFile[]; canBackup: boolean; canRestore: boolean; viewOnly: string | null }
export interface BackupDone { file: string; copy: string | null; bytes: number; photos: { referenced: number; missing: number } }
export interface RestoreDone {
  version: number; images: { referenced: number; restored: number; alreadyPresent: number; missing: string[] };
  journal: { replayed: number; skipped: number; errors: unknown[]; keptAside: boolean }; stockOk: boolean; aside: string | null;
}

async function call<T>(method: string, path: string, body?: unknown, accept = 'application/json'): Promise<{ data: T; text: string }> {
  const headers: Record<string, string> = { Accept: accept };
  const token = currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError('NETWORK', 'Tiffin Data Manager is starting. Try again in a moment.', 0); }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* csv */ }
  if (!res.ok) {
    const e = (data as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(e?.code ?? `HTTP_${res.status}`, e?.message ?? 'Something went wrong. Please try again.', res.status);
  }
  return { data: data as T, text };
}

const enc = encodeURIComponent;
export const mgr = {
  status: async () => (await call<Status>('GET', '/mgr/status')).data,
  open: async (origin: 'data' | 'folder' | 'file', path?: string) => (await call<Status>('POST', '/mgr/open', { origin, path })).data,
  tables: async () => (await call<TableInfo[]>('GET', '/mgr/tables')).data,
  table: async (name: string, q: string, offset: number, limit: number) =>
    (await call<TablePage>('GET', `/mgr/tables/${enc(name)}?q=${enc(q)}&offset=${offset}&limit=${limit}`)).data,
  tableCsv: async (name: string, q: string) => (await call<null>('GET', `/mgr/tables/${enc(name)}/csv?q=${enc(q)}`, undefined, 'text/csv')).text,
  backups: async () => (await call<Backups>('GET', '/mgr/backups')).data,
  backup: async (copyTo: string | null) => (await call<BackupDone>('POST', '/mgr/backup', { copyTo })).data,
  restore: async (path: string, pin: string) => (await call<RestoreDone>('POST', '/mgr/restore', { path, pin })).data,
};

/** Windows' own folder or file picker (the desktop app answers these; the page itself has no file access). */
export async function choose(what: 'folder' | 'file'): Promise<string | null> {
  try {
    const r = await fetch(`/__desktop/choose-${what}`, { method: 'POST' });
    if (!r.ok) return null;
    return ((await r.json()) as { path: string | null }).path;
  } catch { return null; }
}
