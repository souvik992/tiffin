import { useCallback, useEffect, useState } from 'react';
import { DatabaseBackup, FolderOpen, History, Usb } from 'lucide-react';
import { Modal, PageShell } from '../components/ui.tsx';
import { useSession } from '../lib/session.tsx';
import { formatIstDateTime } from '../lib/dates.ts';
import { choose, mgr } from './mgr.ts';
import type { Backups as BackupList, RestoreDone } from './mgr.ts';

const KIND: Record<string, string> = { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', close: 'On closing', manual: 'By hand' };
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const sep = (folder: string) => (folder.includes('\\') ? '\\' : '/');

export function Backups({ onChanged }: { onChanged: () => void }) {
  const { fail, notify } = useSession();
  const [list, setList] = useState<BackupList | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [done, setDone] = useState<RestoreDone | null>(null);

  const load = useCallback(() => { mgr.backups().then(setList).catch(fail); }, [fail]);
  useEffect(load, [load]);

  const backup = async (toDrive: boolean) => {
    const copyTo = toDrive ? await choose('folder') : null;
    if (toDrive && !copyTo) return;
    setBusy(true);
    try {
      const r = await mgr.backup(copyTo);
      notify('success', r.copy ? `Backup saved and copied to ${r.copy}` : 'Backup saved and checked.');
      if (r.photos.missing) notify('info', `${r.photos.missing} menu photo(s) were missing from the data folder and are not in the backup.`);
      load();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const pickFile = async () => { const f = await choose('file'); if (f) setRestoring(f); };

  return (
    <PageShell route="backups" title="Backups" subtitle="Save a copy of all your shop's data, or bring an earlier copy back.">
      {!list ? <p className="text-muted-foreground">Loading…</p> : (
        <div className="max-w-4xl space-y-5">
          {list.viewOnly && <p className="rounded-xl border border-border bg-accent p-3 text-sm text-accent-foreground">{list.viewOnly}</p>}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-semibold">Back up now</h2>
            <p className="mt-1 text-sm text-muted-foreground">A checked copy of every bill, the menu, stock, staff and settings, with the menu photos. Works while the POS is open too.</p>
            {list.folder && <p className="mt-1 text-xs text-muted-foreground">Saved in {list.folder}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-primary" disabled={busy || !list.canBackup} onClick={() => void backup(false)}><DatabaseBackup className="h-4 w-4" />{busy ? 'Backing up…' : 'Back up now'}</button>
              <button className="btn-ghost" disabled={busy || !list.canBackup} onClick={() => void backup(true)}><Usb className="h-4 w-4" />Back up and copy to a USB drive or folder…</button>
            </div>
          </section>
          <section className="rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto font-semibold">Restore</h2>
              <button className="btn-ghost" disabled={!list.canRestore} onClick={() => void pickFile()}><FolderOpen className="h-4 w-4" />Restore from a file…</button>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Restoring replaces the shop's data with the backup. The data from before is kept in a "pre-restore" folder, and bills made after the backup are brought back from the bill journal.
              {!list.canRestore && ' Close Tiffin POS first.'}
            </p>
            <table className="table mt-4">
              <thead className="bg-secondary text-left"><tr><th className="px-3 py-2">Taken</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2 text-right">Size</th><th className="px-3 py-2" /></tr></thead>
              <tbody>
                {list.files.map((f) => (
                  <tr key={f.file} className="border-t border-border">
                    <td className="px-3 py-2">{formatIstDateTime(f.at)}</td>
                    <td className="px-3 py-2">{KIND[f.kind] ?? f.kind}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{size(f.bytes)}</td>
                    <td className="px-3 py-2 text-right"><button className="btn-ghost h-8 px-3 text-xs" disabled={!list.canRestore} onClick={() => setRestoring(`${list.folder}${sep(list.folder!)}${f.file}`)}><History className="h-3.5 w-3.5" />Restore</button></td>
                  </tr>
                ))}
                {!list.files.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No backups in the data folder yet.</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      )}
      {restoring && <RestoreDialog file={restoring} onClose={() => setRestoring(null)} onDone={(r) => { setRestoring(null); setDone(r); load(); onChanged(); }} />}
      {done && (
        <Modal title="Backup restored" onClose={() => setDone(null)}>
          <ul className="space-y-1 text-sm">
            <li>Bills made after the backup brought back: {done.journal.replayed}</li>
            <li>Menu photos: {done.images.restored + done.images.alreadyPresent} of {done.images.referenced}{done.images.missing.length ? ` (${done.images.missing.length} missing)` : ''}</li>
            <li>Stock check: {done.stockOk ? 'correct' : 'needs a look (see Stock)'}</li>
            {done.aside && <li className="text-muted-foreground">The data from before is kept in {done.aside}</li>}
          </ul>
          <button className="btn-primary mt-4 w-full" onClick={() => setDone(null)}>OK</button>
        </Modal>
      )}
    </PageShell>
  );
}

function RestoreDialog({ file, onClose, onDone }: { file: string; onClose: () => void; onDone: (r: RestoreDone) => void }) {
  const { fail } = useSession();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { onDone(await mgr.restore(file, pin)); } catch (e) { fail(e); setPin(''); } finally { setBusy(false); }
  };
  return (
    <Modal title="Restore this backup?" onClose={busy ? () => {} : onClose}>
      <p className="break-all text-sm">{file}</p>
      <p className="mt-2 text-sm text-muted-foreground">The shop's data will be replaced by this backup. Keep Tiffin POS closed until this finishes.</p>
      <label className="mt-4 block text-sm font-medium">Your PIN to confirm
        <input className="field mt-1 w-full" type="password" inputMode="numeric" autoFocus maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && pin.length >= 4) void go(); }} />
      </label>
      <button className="btn-primary mt-4 w-full bg-destructive" disabled={busy || pin.length < 4} onClick={() => void go()}>{busy ? 'Restoring…' : 'Restore'}</button>
    </Modal>
  );
}
