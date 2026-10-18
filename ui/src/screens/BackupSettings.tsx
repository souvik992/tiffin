import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Cloud, CloudUpload, DatabaseBackup, FolderOpen, HardDriveDownload, History, RotateCcw } from 'lucide-react';
import { ApiError } from '../lib/api.ts';
import type { BackupFile, BackupOverview, OnlineBackup, RestoreSource } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';
import { onAndroid } from '../lib/android.ts';
import { AndroidBackupCopies } from './DeviceSettings.tsx';

const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const KIND: Record<string, string> = { hourly: 'Hourly', daily: 'Daily', weekly: 'Weekly', close: 'When the POS closed', manual: 'Made by hand' };
/** "hourly-20261018T091500123Z.db(.gz)" -> its time. */
const timeOf = (name: string) => {
  const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!) : 0;
};
const kindOf = (name: string) => KIND[name.split('-')[0] ?? ''] ?? 'Backup';
const sourceName = (s: string) => (s === 'device' ? (onAndroid() ? 'this device' : 'this PC') : s === 'folder' ? 'the USB drive or folder' : s === 'online' ? 'the online backup server' : 'a backup');

interface Pick { source: RestoreSource; name: string; folder?: string }

/** Settings > Backups (owner): backups on this device, copies to a USB drive or folder, online backups, and restore. */
export function BackupSettings() {
  const { api, notify } = useSession();
  const [ov, setOv] = useState<BackupOverview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const load = useCallback(() => api.backupOverview().then(setOv).catch((e) => notify('error', messageOf(e))), [api, notify]);
  useEffect(() => { void load(); }, [load]);
  // an online upload runs in the background: refresh while it does
  useEffect(() => { if (!ov?.cloud.busy) return; const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [ov?.cloud.busy, load]);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try { const r = await fn(); if (r && typeof r === 'object' && 'files' in r && 'cloud' in r) setOv(r as BackupOverview); else await load(); if (done) notify('success', done); }
    catch (e) { notify('error', messageOf(e)); await load(); }
    finally { setBusy(null); }
  };

  if (!ov) return <p className="text-sm text-muted-foreground">Loading backups…</p>;
  const last = ov.lastRestore;
  return (
    <>
      <h2 className="mb-1 font-display text-2xl">Backups</h2>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">The POS backs up by itself every hour, every day and when it closes, and checks every backup. Keep copies away from this {onAndroid() ? 'device' : 'PC'} too: on a USB drive, online, or both. Then the bills survive if it is lost, stolen or broken.</p>

      {last && (
        <div role="status" className={`mb-4 max-w-3xl rounded-2xl border p-4 text-sm ${last.ok ? 'border-veg/40 bg-veg/10' : 'border-destructive/40 bg-destructive/10'}`}>
          <p className="flex items-center gap-2 font-semibold">{last.ok ? <CheckCircle2 className="h-4 w-4 text-veg" /> : <CircleAlert className="h-4 w-4 text-destructive" />}
            {last.ok ? `Backup of ${when(timeOf(last.label))} restored, from ${sourceName(last.label.split(' ')[0] ?? '')}.` : 'The restore did not finish. Nothing was changed.'}</p>
          {last.ok && last.report && (
            <ul className="mt-1 list-disc pl-6 text-muted-foreground">
              {last.report.journal.keptAside
                ? <li>The data that was on this {onAndroid() ? 'device' : 'PC'} before belonged to another shop or counter. It was kept aside, not mixed in.</li>
                : <li>{last.report.journal.replayed > 0 ? `${last.report.journal.replayed} later bill change(s) made on this ${onAndroid() ? 'device' : 'PC'} were added back, so no bill is lost.` : 'Nothing newer had to be added back.'}</li>}
              {last.report.images.missing.length > 0 && <li>{last.report.images.missing.length} menu photo(s) were not in the backup. Upload them again on Menu creation.</li>}
              {last.report.journal.errors.length > 0 && <li className="text-destructive">{last.report.journal.errors.length} later change(s) could not be added back. Contact support.</li>}
              {!last.report.stockOk && <li className="text-destructive">Stock balances need a check: contact support.</li>}
              {last.report.aside && <li>The data from before the restore is kept in {last.report.aside}</li>}
            </ul>
          )}
          {!last.ok && <p className="mt-1 text-muted-foreground">{last.error}</p>}
          <button className="btn-ghost mt-2 h-8 px-3 text-xs" onClick={() => void api.dismissRestore().then(load)}>OK</button>
        </div>
      )}

      {/* ---------------------------------------------------------------- this device */}
      <section className="max-w-3xl rounded-2xl border border-border bg-card p-4" aria-label="Backups on this device">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><DatabaseBackup className="h-4 w-4 text-primary" />On this {onAndroid() ? 'device' : 'PC'}</h3>
        <p className={`text-sm ${ov.status.warn ? 'text-destructive' : 'text-muted-foreground'}`}>{ov.status.lastBackupAt ? `Last backup ${when(ov.status.lastBackupAt)}.` : 'No backup yet.'}{ov.status.warn && ov.status.lastBackupAt ? ' That is more than a day ago.' : ''}</p>
        <button className="btn-primary mt-3" disabled={busy !== null} onClick={() => void run('now', () => api.backupNow(), 'Backup made and checked.')}>{busy === 'now' ? 'Backing up…' : 'Back up now'}</button>
        <BackupList files={ov.files} onRestore={(f) => setPick({ source: 'device', name: f.file })} empty="No backups yet." />
      </section>

      {/* ---------------------------------------------------------------- offline copy */}
      <div className="mt-4">
        {onAndroid() ? <AndroidBackupCopies /> : (
          <section className="max-w-3xl rounded-2xl border border-border bg-card p-4" aria-label="Copies on a USB drive or folder">
            <h3 className="mb-1 flex items-center gap-2 font-semibold"><HardDriveDownload className="h-4 w-4 text-primary" />Copy to a USB drive or another folder (offline)</h3>
            {ov.copy.dir ? (
              <>
                <p className="text-sm">Folder: <b className="break-all">{ov.copy.dir}</b> (in it: <b>TiffinPOS-backups</b>)</p>
                <p className="text-sm text-muted-foreground">{ov.copy.lastAt ? `Last copied ${when(ov.copy.lastAt)}. Every new backup is copied there too.` : 'Not copied yet.'}</p>
                {ov.copy.error && <p role="alert" className="mt-1 text-sm text-destructive">{ov.copy.error}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn-primary" disabled={busy !== null} onClick={() => void run('copy', () => api.copyBackupNow(), 'Copied.')}>{busy === 'copy' ? 'Copying…' : 'Copy now'}</button>
                  <ChooseFolder label="Choose another folder" disabled={busy !== null} onChosen={(d) => void run('folder', () => api.setBackupCopyFolder(d), 'Folder saved.')} />
                  <button className="btn-ghost" disabled={busy !== null} onClick={() => void run('stop', () => api.setBackupCopyFolder(null), 'Copies stopped. The copies already made stay on the drive.')}>Stop copying</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Plug in a USB drive (or use an external disk or network folder), then choose a folder on it. Every backup is then also copied there and checked. Take the drive home at night for the best protection.</p>
                <div className="mt-3"><ChooseFolder label="Choose folder" primary disabled={busy !== null} onChosen={(d) => void run('folder', () => api.setBackupCopyFolder(d), 'Folder saved. The newest backup was copied.')} /></div>
              </>
            )}
            <button className="btn-ghost mt-3" onClick={() => setFolderOpen(true)}><RotateCcw className="h-4 w-4" />Restore from a USB drive or folder</button>
          </section>
        )}
      </div>

      {/* ---------------------------------------------------------------- online */}
      <section className="mt-4 max-w-3xl rounded-2xl border border-border bg-card p-4" aria-label="Online backup">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><Cloud className="h-4 w-4 text-primary" />Online backup (Tiffin backup server)</h3>
        {ov.cloud.connected ? (
          <>
            <p className="text-sm">Connected as <b>{ov.cloud.store}</b> to <span className="break-all">{ov.cloud.url}</span></p>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-primary" checked={ov.cloud.on} disabled={busy !== null} onChange={(e) => void run('on', () => api.setCloudBackup({ on: e.target.checked }))} />Upload backups automatically</label>
              <label className="flex items-center gap-2">Every
                <select className="field h-9 py-0" value={ov.cloud.everyHours} disabled={busy !== null || !ov.cloud.on} onChange={(e) => void run('every', () => api.setCloudBackup({ everyHours: Number(e.target.value) }))} aria-label="How often">
                  {ov.everyHoursChoices.map((h) => <option key={h} value={h}>{h === 1 ? '1 hour' : `${h} hours`}</option>)}
                </select>
              </label>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{ov.cloud.busy ? 'Uploading now…' : ov.cloud.lastAt ? `Last uploaded ${when(ov.cloud.lastAt)}.` : 'Nothing uploaded yet.'} {ov.cloud.on && !ov.cloud.busy ? 'Uploads need the internet; billing never waits for them.' : ''}</p>
            {ov.cloud.error && <p role="alert" className="mt-1 text-sm text-destructive">{ov.cloud.error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="btn-primary" disabled={busy !== null || ov.cloud.busy} onClick={() => void run('cloud', () => api.cloudBackupNow(), 'Backed up online.')}><CloudUpload className="h-4 w-4" />{busy === 'cloud' ? 'Uploading…' : 'Back up online now'}</button>
              <button className="btn-ghost" onClick={() => setOnlineOpen(true)}><RotateCcw className="h-4 w-4" />Restore from online</button>
              <button className="btn-ghost" disabled={busy !== null} onClick={() => { if (window.confirm('Disconnect from the backup server? Backups already online stay there; you need a new pairing code to connect again.')) void run('off', () => api.disconnectCloudBackup(), 'Disconnected.'); }}>Disconnect</button>
            </div>
          </>
        ) : <PairCloud busy={busy !== null} onPair={(url, code) => run('pair', () => api.pairCloudBackup(url, code), 'Connected. The first online backup starts within a few minutes.')} />}
      </section>

      {folderOpen && <FolderRestore initial={ov.copy.dir ?? ''} onClose={() => setFolderOpen(false)} onPick={(p) => { setFolderOpen(false); setPick(p); }} />}
      {onlineOpen && <OnlineRestore onClose={() => setOnlineOpen(false)} onPick={(p) => { setOnlineOpen(false); setPick(p); }} />}
      {pick && <ConfirmRestore pick={pick} canRestartItself={ov.canRestartItself} onClose={() => setPick(null)} />}
    </>
  );
}

function BackupList({ files, onRestore, empty }: { files: Array<BackupFile | (OnlineBackup & { file?: undefined })>; onRestore: (f: { file: string }) => void; empty: string }) {
  const [all, setAll] = useState(false);
  const rows = files.map((f) => ('file' in f && f.file ? { name: f.file, at: f.at, bytes: f.bytes } : { name: (f as OnlineBackup).name, at: timeOf((f as OnlineBackup).name), bytes: f.bytes }));
  if (!rows.length) return <p className="mt-3 text-sm text-muted-foreground">{empty}</p>;
  const shown = all ? rows : rows.slice(0, 6);
  return (
    <div className="mt-3">
      <ul className="divide-y divide-border rounded-xl border border-border text-sm">
        {shown.map((r) => (
          <li key={r.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <History className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-40 font-medium tabular-nums">{when(r.at)}</span>
            <span className="text-muted-foreground">{kindOf(r.name)}</span>
            <span className="text-muted-foreground tabular-nums">{size(r.bytes)}</span>
            <button className="btn-ghost ml-auto h-8 px-3 text-xs" onClick={() => onRestore({ file: r.name })}>Restore…</button>
          </li>
        ))}
      </ul>
      {rows.length > 6 && <button className="btn-ghost mt-2 h-8 px-3 text-xs" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </div>
  );
}

/** Windows' folder picker in the desktop app; elsewhere (or if it is not there) the folder is typed. */
function ChooseFolder({ label, onChosen, primary, disabled }: { label: string; onChosen: (dir: string) => void; primary?: boolean; disabled?: boolean }) {
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState('');
  const choose = async () => {
    try {
      const r = await fetch('/__desktop/choose-folder', { method: 'POST' });
      if (!r.ok) throw new Error('no picker');
      const { path: p } = await r.json() as { path: string | null };
      if (p) onChosen(p);
    } catch { setTyping(true); }
  };
  if (typing) return (
    <form className="flex w-full flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (path.trim()) onChosen(path.trim()); }}>
      <input className="field min-w-64 flex-1" value={path} onChange={(e) => setPath(e.target.value)} placeholder="E:\ or D:\Backups" aria-label="Folder" autoFocus />
      <button className="btn-primary" disabled={disabled || !path.trim()}>Use this folder</button>
    </form>
  );
  return <button className={primary ? 'btn-primary' : 'btn-ghost'} disabled={disabled} onClick={() => void choose()}><FolderOpen className="h-4 w-4" />{label}</button>;
}

function PairCloud({ onPair, busy }: { onPair: (url: string, code: string) => Promise<void>; busy: boolean }) {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  return (
    <form className="mt-1" onSubmit={(e) => { e.preventDefault(); void onPair(url.trim(), code.trim()); }}>
      <p className="text-sm text-muted-foreground">Backups are uploaded to the Tiffin backup server, so they are safe even if every device in the shop is lost. Ask Tiffin POS support for the server address and a pairing code (it works once, for 30 minutes).</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_12rem]">
        <label className="text-sm">Server address<input className="field mt-1 w-full" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://backup.example.in" inputMode="url" autoComplete="off" /></label>
        <label className="text-sm">Pairing code<input className="field mt-1 w-full uppercase tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-2345" autoComplete="off" /></label>
      </div>
      <button className="btn-primary mt-3" disabled={busy || !url.trim() || !code.trim()}><Cloud className="h-4 w-4" />{busy ? 'Connecting…' : 'Connect'}</button>
    </form>
  );
}

function FolderRestore({ initial, onClose, onPick }: { initial: string; onClose: () => void; onPick: (p: Pick) => void }) {
  const { api } = useSession();
  const [path, setPath] = useState(initial);
  const [found, setFound] = useState<{ folder: string; files: BackupFile[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const look = async (p: string) => { setErr(null); setFound(null); try { setFound(await api.backupsInFolder(p)); } catch (e) { setErr(messageOf(e)); } };
  useEffect(() => { if (initial) void look(initial); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Restore from a USB drive or folder" onClose={onClose} width="max-w-2xl">
      <p className="text-sm text-muted-foreground">Choose the drive or folder with the backups (the TiffinPOS-backups folder, or the drive it is on).</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <ChooseFolder label="Choose folder" primary onChosen={(d) => { setPath(d); void look(d); }} />
        {path && <span className="self-center break-all text-sm">{path}</span>}
      </div>
      {err && <p role="alert" className="mt-3 text-sm text-destructive">{err}</p>}
      {found && <BackupList files={found.files} empty="No backups in this folder." onRestore={(f) => onPick({ source: 'folder', name: f.file, folder: found.folder })} />}
    </Modal>
  );
}

function OnlineRestore({ onClose, onPick }: { onClose: () => void; onPick: (p: Pick) => void }) {
  const { api } = useSession();
  const [list, setList] = useState<OnlineBackup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.onlineBackups().then((r) => setList(r.backups)).catch((e) => setErr(messageOf(e))); }, [api]);
  return (
    <Modal title="Restore from online" onClose={onClose} width="max-w-2xl">
      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : !list ? <p className="text-sm text-muted-foreground">Asking the backup server…</p>
        : <BackupList files={list} empty="No online backups yet." onRestore={(f) => onPick({ source: 'online', name: f.file })} />}
    </Modal>
  );
}

function ConfirmRestore({ pick, canRestartItself, onClose }: { pick: Pick; canRestartItself: boolean; onClose: () => void }) {
  const { api } = useSession();
  const [pin, setPin] = useState('');
  const [state, setState] = useState<'ask' | 'working' | 'restarting' | 'manual'>('ask');
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null); setState('working');
    try {
      const r = await api.restoreBackup(pick.source, pick.name, pin, pick.folder);
      if (!r.restarting) { setState('manual'); return; }
      setState('restarting');
      // The POS restarts itself and applies the backup; sign-ins start fresh, which is how we know it is back.
      try { sessionStorage.setItem('pos.settings.section', 'backups'); } catch { /* storage unavailable */ }
      for (let i = 0; i < 600; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        try { await api.me(); } catch (e) { if (e instanceof ApiError && e.status === 401) break; }
      }
      window.location.reload();
    } catch (e) { setErr(messageOf(e)); setState('ask'); setPin(''); }
  };
  return (
    <Modal title="Restore this backup?" onClose={state === 'ask' ? onClose : () => {}}>
      {state === 'restarting' ? (
        <div className="py-4 text-center" role="status">
          <RotateCcw className="mx-auto h-8 w-8 animate-spin text-primary" />
          <p className="mt-3 font-semibold">Restoring… the POS is restarting.</p>
          <p className="text-sm text-muted-foreground">This takes a few seconds (longer for a big backup). Then sign in again.</p>
        </div>
      ) : state === 'manual' ? (
        <div className="py-2" role="status">
          <p className="font-semibold">The backup is ready to restore.</p>
          <p className="mt-1 text-sm text-muted-foreground">Close the POS and open it again to finish. It is restored as the POS starts.</p>
        </div>
      ) : (
        <>
          <p className="text-sm">Backup of <b>{when(timeOf(pick.name))}</b> ({kindOf(pick.name).toLowerCase()}), from {sourceName(pick.source)}.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>The POS goes back to this backup: menu, settings, staff, stock and bills.</li>
            <li>Bills made on this {onAndroid() ? 'device' : 'PC'} after the backup are added back, so no bill is lost.</li>
            <li>The current data is kept aside, never deleted.</li>
            <li>{canRestartItself ? 'The POS restarts and everyone signs in again.' : 'Then close the POS and open it again.'} Finish any open bill first.</li>
          </ul>
          <label className="mt-4 block text-sm">Your PIN, to confirm
            <input className="field mt-1 w-full tracking-[0.4em]" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label="PIN" autoFocus />
          </label>
          {err && <p role="alert" className="mt-2 text-sm text-destructive">{err}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose} disabled={state === 'working'}>Cancel</button>
            <button className="btn-primary bg-destructive hover:bg-destructive/90" disabled={pin.length < 4 || state === 'working'} onClick={() => void go()}>
              {state === 'working' ? (pick.source === 'online' ? 'Downloading…' : 'Checking…') : 'Restore'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
