import { useEffect, useState } from 'react';
import { FolderOpen, HardDriveDownload } from 'lucide-react';
import { useSession } from '../lib/session.tsx';
import { androidApp, backupCopyStatus } from '../lib/android.ts';
import type { BackupCopyStatus } from '../lib/android.ts';

const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Settings > This device (Android app only): copies of the backups on a USB stick or SD card. */
export function DeviceSettings() {
  const { notify } = useSession();
  const [st, setSt] = useState<BackupCopyStatus | null>(backupCopyStatus);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const t = setInterval(() => setSt(backupCopyStatus()), 3000); return () => clearInterval(t); }, []); // the folder picker answers later
  const a = androidApp();
  if (!a) return <p className="text-sm text-muted-foreground">This page is for the Android app.</p>;

  const copy = () => {
    setBusy(true);
    setTimeout(() => { // let the button show "Copying…" first: the copy runs while this waits
      const n = a.copyBackupsNow();
      setBusy(false); setSt(backupCopyStatus());
      notify(n < 0 ? 'error' : 'success', n < 0 ? 'The backups could not be copied. Is the USB stick or SD card still in?' : n === 0 ? 'The folder already has every backup.' : `${n} backup file(s) copied.`);
    }, 50);
  };

  return (
    <>
      <h2 className="mb-1 font-display text-2xl">This device</h2>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">The POS keeps verified backups on this device (every hour and every day). Also keep copies on a USB stick or SD card, so the bills survive if this device is lost or broken.</p>
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
        <p className="mt-3 text-xs text-muted-foreground">To restore on another device or PC, copy the newest .db file from TiffinPOS-backups and use the restore steps in the guide.</p>
      </section>
    </>
  );
}
