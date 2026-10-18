import { useEffect, useState } from 'react';
import { FolderOpen, HardDriveDownload, PackagePlus, Trash2 } from 'lucide-react';
import type { AddonInfo } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { androidApp, backupCopyStatus } from '../lib/android.ts';
import type { BackupCopyStatus } from '../lib/android.ts';

const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Settings > Backups on Android: backup copies on a USB stick or SD card (the app copies them; the folder picker is Android's). */
export function AndroidBackupCopies() {
  const { notify } = useSession();
  const [st, setSt] = useState<BackupCopyStatus | null>(backupCopyStatus);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setInterval(() => setSt(backupCopyStatus()), 3000); return () => clearInterval(t); }, []); // the folder picker answers later
  const a = androidApp();
  if (!a) return null;

  const copy = () => {
    setBusy(true);
    setTimeout(() => { // let the button show "Copying…" first: the copy runs while this waits
      const n = a.copyBackupsNow();
      setBusy(false); setSt(backupCopyStatus());
      notify(n < 0 ? 'error' : 'success', n < 0 ? 'The backups could not be copied. Is the USB stick or SD card still in?' : n === 0 ? 'The folder already has every backup.' : `${n} backup file(s) copied.`);
    }, 50);
  };

  return (
      <section className="max-w-2xl rounded-2xl border border-border bg-card p-4" aria-label="Backup copies">
        <h3 className="mb-2 flex items-center gap-2 font-semibold"><HardDriveDownload className="h-4 w-4 text-primary" />Backup copies on a USB stick or SD card</h3>
        {st?.folder ? (
          <>
            <p className="text-sm">Folder: <b>{st.folder}</b> (in it: <b>TiffinPOS-backups</b>)</p>
            <p className="text-sm text-muted-foreground">{st.lastCopiedAt ? `Last copied ${when(st.lastCopiedAt)}. New backups are copied every 15 minutes while the app runs.` : 'Not copied yet.'}</p>
            {st.lastError && <p role="alert" className="mt-1 text-sm text-destructive">{st.lastError}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-primary" disabled={busy} onClick={copy}>{busy ? 'Copying…' : 'Copy now'}</button>
              <button className="btn-ghost" onClick={() => a.chooseBackupFolder()}><FolderOpen className="h-4 w-4" />Choose another folder</button>
              <button className="btn-ghost" onClick={() => { a.forgetBackupFolder(); setSt(backupCopyStatus()); }}>Stop copying</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Insert the USB stick (with an OTG cable) or SD card, then choose a folder on it.</p>
            <button className="btn-primary mt-3" onClick={() => a.chooseBackupFolder()}><FolderOpen className="h-4 w-4" />Choose folder</button>
          </>
        )}
        <p className="mt-3 text-xs text-muted-foreground">To restore on a PC, choose the TiffinPOS-backups folder in Settings &gt; Backups &gt; Restore from a USB drive or folder.</p>
      </section>
  );
}

/** Settings > This device (Android app only): add-ons. Backup copies are on Settings > Backups. */
export function DeviceSettings() {
  const { api, user } = useSession();
  const [addons, setAddons] = useState<AddonInfo[] | null>(null);
  useEffect(() => { api.addons().then(setAddons).catch(() => setAddons([])); }, [api]);
  const a = androidApp();
  if (!a) return <p className="text-sm text-muted-foreground">This page is for the Android app.</p>;

  return (
    <>
      <h2 className="mb-4 font-display text-2xl">This device</h2>
      <section className="max-w-2xl rounded-2xl border border-border bg-card p-4" aria-label="Add-ons">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><PackagePlus className="h-4 w-4 text-primary" />Add-ons</h3>
        <p className="mb-3 text-sm text-muted-foreground">Extra modules such as ODS (online orders and serviceability), installed from a <b>.tiffinaddon</b> file. The POS checks each add-on's signature before using it, as on Windows.</p>
        {addons?.length === 0 && <p className="text-sm text-muted-foreground">No add-ons installed.</p>}
        <ul className="space-y-2">
          {addons?.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3 text-sm">
              <b>{x.name}</b><span className="text-muted-foreground">{x.version}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${x.status === 'active' ? 'bg-primary/15 text-primary' : 'bg-destructive/15 text-destructive'}`}>{x.status === 'active' ? 'Working' : 'Switched off'}</span>
              {x.reason && <span className="w-full text-xs text-destructive">{x.reason}</span>}
              {user?.role === 'owner' && <button className="btn-ghost ml-auto h-8 px-3 text-xs" onClick={() => { if (window.confirm(`Remove ${x.name}? Its settings and data stay in the POS.`)) a.removeAddon(x.id); }}><Trash2 className="h-3.5 w-3.5" />Remove</button>}
            </li>
          ))}
        </ul>
        {user?.role === 'owner'
          ? <button className="btn-primary mt-3" onClick={() => a.installAddon()}><PackagePlus className="h-4 w-4" />Install from file</button>
          : <p className="mt-3 text-xs text-muted-foreground">Only the owner can install or remove add-ons.</p>}
      </section>
    </>
  );
}
