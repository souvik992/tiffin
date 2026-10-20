import { useCallback, useEffect, useRef, useState } from 'react';
import { Cable, CheckCircle2, CircleAlert, Pencil, Plus, Trash2, Wifi } from 'lucide-react';
import { edc, host, onAndroid } from './host.ts';
import { ProviderLogo } from './logos.tsx';
import type { Connection as TerminalConnection, Machine as PaymentTerminal, MachineInput as TerminalInput, MatchRow, Provider as TerminalProvider } from './host.ts';

const { useSession, Modal, newKey, messageOf } = host;
type SerialPortInfo = { port: string; name: string; bluetooth: boolean };

const CONNECTION: Record<TerminalConnection, { label: string; hint: string }> = {
  cloud: { label: 'Wireless (internet)', hint: 'The POS sends the amount over the internet; the machine shows it. Needs internet at the counter.' },
  wired: { label: 'Wired (USB or LAN cable)', hint: 'The machine is connected to this PC with a cable. Works without internet at the counter.' },
};
const PROVIDERS: Array<{ id: TerminalProvider; name: string }> = [{ id: 'paytm', name: 'Paytm' }, { id: 'pinelabs', name: 'Pine Labs' }];

/** Settings > Payment machines (owner): card machines (EDC) that the counter can send Card and UPI payments to. */
export function PaymentMachines() {
  const { api, fail, notify } = useSession();
  const [list, setList] = useState<PaymentTerminal[] | null>(null);
  const [editing, setEditing] = useState<PaymentTerminal | 'new' | null>(null);
  const [checks, setChecks] = useState<Record<string, { ok: boolean; message: string } | 'busy'>>({});
  const load = useCallback(() => edc(api).machines().then(setList).catch(fail), [api, fail]);
  useEffect(() => { void load(); }, [load]);
  const check = async (t: PaymentTerminal) => {
    setChecks((c) => ({ ...c, [t.id]: 'busy' }));
    try { const r = await edc(api).check(t.id); setChecks((c) => ({ ...c, [t.id]: r })); } catch (e) { setChecks((c) => ({ ...c, [t.id]: { ok: false, message: messageOf(e) } })); }
  };
  const remove = async (t: PaymentTerminal) => {
    if (!window.confirm(`Remove ${t.name}? Its past payments stay in the reports.`)) return;
    try { await edc(api).remove(t.id, newKey()); notify('success', `${t.name} removed.`); await load(); } catch (e) { fail(e); }
  };
  return (
    <>
      <h2 className="mb-1 font-display text-2xl">Payment machines</h2>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">Card machines (EDC) from Paytm or Pine Labs. At the counter, Card and UPI payments are sent to the machine; the bill is saved only when the machine approves, with its approval code. Your Paytm or Pine Labs account gives you the details below (merchant ID, terminal ID and key).</p>
      <div className="mb-4"><button className="btn-primary" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add a machine</button></div>
      {list === null ? <p className="text-sm text-muted-foreground">Loading…</p> : list.length === 0 ? (
        <p className="max-w-3xl rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">No machine yet. Card and UPI payments are entered by hand, as before.</p>
      ) : (
        <ul className="max-w-3xl space-y-3">
          {list.map((t) => {
            const c = checks[t.id];
            return (
              <li key={t.id} className={`rounded-2xl border border-border bg-card p-4 ${t.active ? '' : 'opacity-60'}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-10 w-24 shrink-0 items-center justify-center rounded-lg border border-border bg-white px-2"><ProviderLogo provider={t.provider} className="h-6 w-full" /></span>
                  <div className="min-w-48 flex-1">
                    <p className="font-semibold">{t.name}{t.isDefault && <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">Default</span>}{!t.active && <span className="ml-2 text-xs text-muted-foreground">(switched off)</span>}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{t.connection === 'cloud' ? <Wifi className="h-3.5 w-3.5" /> : <Cable className="h-3.5 w-3.5" />}{CONNECTION[t.connection].label} · {t.modes.map((m) => (m === 'UPI' ? 'UPI' : 'Card')).join(' and ')}{t.config.env === 'test' ? ' · TEST server' : ''}</p>
                  </div>
                  <button className="btn-ghost h-9" disabled={c === 'busy'} onClick={() => void check(t)}>{c === 'busy' ? 'Testing…' : 'Test'}</button>
                  <button className="btn-ghost h-9 px-3" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}><Pencil className="h-4 w-4" /></button>
                  <button className="btn-ghost h-9 px-3 text-destructive" onClick={() => void remove(t)} aria-label={`Remove ${t.name}`}><Trash2 className="h-4 w-4" /></button>
                </div>
                {c && c !== 'busy' && <p role="status" className={`mt-2 flex items-start gap-1.5 text-sm ${c.ok ? 'text-veg' : 'text-destructive'}`}>{c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}{c.message}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <DailyMatch />
      {editing && <MachineDialog machine={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
    </>
  );
}

type Field = { key: string; label: string; hint?: string; placeholder?: string; type?: 'text' | 'number' };
/** What each machine needs (the same rules are checked by the POS engine). */
const FIELDS: Record<string, Field[]> = {
  'paytm/cloud': [
    { key: 'mid', label: 'Paytm merchant ID (MID)', placeholder: 'From Paytm' },
    { key: 'tid', label: 'Terminal ID (TID)', hint: 'The 8-digit ID of this machine', placeholder: '12345678' },
    { key: 'channelId', label: 'Channel ID', hint: 'Given by Paytm for billing software' },
  ],
  'paytm/wired': [
    { key: 'mid', label: 'Paytm merchant ID (MID)', placeholder: 'From Paytm' },
    { key: 'libFolder', label: 'Folder with Paytm\'s library', hint: 'Download Paytm\'s wired library (Paytm_EDC on GitHub: wired / netV4.0) into a folder and enter it here.', placeholder: 'C:\\PaytmEDC' },
  ],
  'pinelabs/cloud': [
    { key: 'merchantId', label: 'Pine Labs merchant ID', placeholder: '1234' },
    { key: 'storeId', label: 'Store ID', placeholder: '61607' },
    { key: 'clientId', label: 'Client ID (this machine)', hint: 'Needed when one PC uses one machine' },
  ],
  'pinelabs/wired': [
    { key: 'host', label: 'PC running the Pine Labs PAD Controller', hint: 'Install Pine Labs\' PAD Controller and connect the machine to it (USB, serial or LAN cable). 127.0.0.1 = this PC.', placeholder: '127.0.0.1' },
    { key: 'port', label: 'Port', placeholder: '8082', type: 'number' },
  ],
};

function MachineDialog({ machine, onClose, onSaved }: { machine: PaymentTerminal | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [provider, setProvider] = useState<TerminalProvider>(machine?.provider ?? 'paytm');
  const [connection, setConnection] = useState<TerminalConnection>(machine?.connection ?? 'cloud');
  const [name, setName] = useState(machine?.name ?? '');
  const [modes, setModes] = useState<Array<'CARD' | 'UPI'>>(machine?.modes ?? ['CARD', 'UPI']);
  const [cfg, setCfg] = useState<Record<string, string>>(Object.fromEntries(Object.entries(machine?.config ?? { env: 'test', host: '127.0.0.1', port: 8082, baud: 115200 }).map(([k, v]) => [k, String(v)])));
  const [secret, setSecret] = useState('');
  const [isDefault, setIsDefault] = useState(machine?.isDefault ?? true);
  const [active, setActive] = useState(machine?.active ?? true);
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const kind = `${provider}/${connection}`;
  const set = (k: string, v: string) => setCfg((c) => ({ ...c, [k]: v }));
  const paytmUsb = provider === 'paytm' && connection === 'wired';
  useEffect(() => { if (paytmUsb && ports === null) api.serialPorts().then(setPorts).catch(() => setPorts([])); }, [api, paytmUsb, ports]);
  const needsSecret = connection === 'cloud';
  const pineCable = provider === 'pinelabs' && connection === 'wired';

  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Name the machine, for example "Counter Paytm".');
    const fields = [...(FIELDS[kind] ?? []).map((f) => f.key), ...(connection === 'cloud' ? ['env', 'liveUrl'] : []), ...(paytmUsb ? ['comPort', 'baud'] : [])];
    const config: Record<string, string | number> = {};
    for (const k of fields) { const v = (cfg[k] ?? '').trim(); if (v) config[k] = k === 'port' || k === 'baud' ? Number(v) : v; }
    const input: TerminalInput = { name: name.trim(), provider, connection, modes: pineCable ? ['CARD'] : modes, config, secret: secret.trim() || null, isDefault, active };
    setBusy(true);
    try { await edc(api).save(machine?.id ?? null, input, key.current); notify('success', `${input.name} saved. Use Test to check the connection.`); await onSaved(); } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={machine ? `Edit ${machine.name}` : 'Add a payment machine'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4 text-sm">
        <div>
          <span className="mb-1 block font-medium">Company</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Company">
            {PROVIDERS.map((p) => <button key={p.id} type="button" role="radio" aria-checked={provider === p.id} aria-label={p.name} title={p.name} className={`flex h-14 flex-1 items-center justify-center rounded-xl border-2 bg-white px-3 transition-colors ${provider === p.id ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary'}`} onClick={() => setProvider(p.id)}><ProviderLogo provider={p.id} className="h-7 max-w-full" /></button>)}
          </div>
        </div>
        <div>
          <span className="mb-1 block font-medium">Connection</span>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Connection">
            {(['cloud', 'wired'] as const).map((c) => {
              const unavailable = c === 'wired' && provider === 'paytm' && onAndroid();
              return (
                <button key={c} type="button" role="radio" aria-checked={connection === c} disabled={unavailable} className={`rounded-xl border p-3 text-left ${connection === c ? 'border-primary bg-accent' : 'border-border bg-card hover:border-primary'} disabled:opacity-50`} onClick={() => setConnection(c)}>
                  <span className="flex items-center gap-2 font-semibold">{c === 'cloud' ? <Wifi className="h-4 w-4 text-primary" /> : <Cable className="h-4 w-4 text-primary" />}{CONNECTION[c].label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{unavailable ? 'Paytm by cable needs the Windows POS.' : CONNECTION[c].hint}</span>
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex flex-col gap-1"><span className="font-medium">Name</span>
          <input className="field" maxLength={40} placeholder={`Counter ${provider === 'paytm' ? 'Paytm' : 'Pine Labs'}`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {paytmUsb && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1"><span className="font-medium">USB / COM port</span>
              <select className="field" value={cfg.comPort ?? ''} onChange={(e) => set('comPort', e.target.value)} aria-label="COM port">
                <option value="">{ports === null ? 'Looking for ports…' : 'Choose the port'}</option>
                {(ports ?? []).map((p) => <option key={p.port} value={p.port}>{p.port} · {p.name}</option>)}
                {cfg.comPort && !(ports ?? []).some((p) => p.port === cfg.comPort) && <option value={cfg.comPort}>{cfg.comPort}</option>}
              </select>
              <span className="text-xs text-muted-foreground">Plug the machine in with its USB cable; it appears as a COM port.</span>
            </label>
            <label className="flex flex-col gap-1"><span className="font-medium">Speed (baud)</span>
              <select className="field" value={cfg.baud ?? '115200'} onChange={(e) => set('baud', e.target.value)}>{[115200, 57600, 38400, 19200, 9600].map((b) => <option key={b} value={b}>{b}</option>)}</select>
            </label>
          </div>
        )}
        {(FIELDS[kind] ?? []).map((f) => (
          <label key={f.key} className="flex flex-col gap-1"><span className="font-medium">{f.label}</span>
            <input className="field" inputMode={f.type === 'number' ? 'numeric' : undefined} placeholder={f.placeholder} value={cfg[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} aria-label={f.label} />
            {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
          </label>
        ))}
        {needsSecret && (
          <label className="flex flex-col gap-1"><span className="font-medium">{provider === 'paytm' ? 'Merchant key' : 'Security token'}</span>
            <input className="field" type="password" autoComplete="off" placeholder={machine?.hasSecret ? 'Saved. Type to replace it.' : provider === 'paytm' ? '16 characters, from Paytm' : 'From Pine Labs'} value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Secret key" />
            <span className="text-xs text-muted-foreground">Kept in the POS only; never shown again.</span>
          </label>
        )}
        {connection === 'cloud' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1"><span className="font-medium">Server</span>
              <select className="field" value={cfg.env ?? 'test'} onChange={(e) => set('env', e.target.value)} aria-label="Server">
                <option value="test">Test (no real money)</option><option value="live">Live</option>
              </select>
            </label>
            {provider === 'paytm' && cfg.env === 'live' && (
              <label className="flex flex-col gap-1"><span className="font-medium">Live server address</span>
                <input className="field" placeholder="https://… (from Paytm)" value={cfg.liveUrl ?? ''} onChange={(e) => set('liveUrl', e.target.value)} aria-label="Live server address" />
              </label>
            )}
          </div>
        )}
        <div>
          <span className="mb-1 block font-medium">Use it for</span>
          <div className="flex flex-wrap gap-4">
            {(['CARD', 'UPI'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-primary" disabled={pineCable && m === 'UPI'} checked={pineCable ? m === 'CARD' : modes.includes(m)} onChange={(e) => setModes((ms) => (e.target.checked ? [...ms, m] : ms.filter((x) => x !== m)))} />{m === 'CARD' ? 'Card payments' : 'UPI payments'}</label>
            ))}
          </div>
          {pineCable && <p className="mt-1 text-xs text-muted-foreground">Pine Labs by cable takes cards here; use the internet connection for UPI.</p>}
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-primary" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />Default machine at the counter</label>
          {machine && <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-primary" checked={active} onChange={(e) => setActive(e.target.checked)} />Switched on</label>}
        </div>
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

/** The daily check: every amount sent to a machine, matched with bills. "Approved, no bill" and "unclear" need a look. */
function DailyMatch() {
  const { api, fail } = useSession();
  const [day, setDay] = useState(today);
  const [r, setR] = useState<{ rows: MatchRow[]; approvedTotal: number; noBill: number; unclear: number } | null>(null);
  useEffect(() => { edc(api).report(day, day).then(setR).catch(fail); }, [api, fail, day]);
  return (
    <section className="mt-6 max-w-3xl rounded-2xl border border-border bg-card p-4" aria-label="Daily match">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Daily match</h3>
        <input type="date" className="field h-9" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} aria-label="Day" />
        {r && <span className="text-sm text-muted-foreground">Approved on machines: <b className="text-foreground">{host.money.formatPaise(r.approvedTotal)}</b></span>}
      </div>
      {r && (r.noBill > 0 || r.unclear > 0) && <p role="alert" className="mb-2 text-sm text-destructive">{r.noBill > 0 ? `${r.noBill} approved without a bill. ` : ''}{r.unclear > 0 ? `${r.unclear} unclear: check the machine's slips.` : ''}</p>}
      {!r ? <p className="text-sm text-muted-foreground">Loading…</p> : r.rows.length === 0 ? <p className="text-sm text-muted-foreground">No machine payments on this day.</p> : (
        <table className="table">
          <thead className="bg-muted text-left"><tr><th className="p-2">Time</th><th className="p-2">Machine</th><th className="p-2">Payment</th><th className="p-2">Result</th><th className="p-2 text-right">Amount</th><th className="p-2">Bill</th><th className="p-2">Match</th></tr></thead>
          <tbody>
            {r.rows.map((x, i) => (
              <tr key={i} className="border-t border-border">
                <td className="p-2 tabular-nums">{timeOf(x.at)}</td><td className="p-2">{x.machine}</td><td className="p-2">{x.what}</td>
                <td className="p-2" title={x.message}>{x.status}</td><td className="p-2 text-right tabular-nums">{x.amount ? host.money.formatPaise(x.amount) : ''}</td>
                <td className="p-2">{x.invoiceNo}</td><td className={`p-2 ${x.match.startsWith('APPROVED, NO BILL') ? 'font-semibold text-destructive' : ''}`}>{x.match}{x.approval ? <span className="block text-xs text-muted-foreground">{x.approval}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Payments are never taken twice: anything unclear is shown as "check the machine".</p>
    </section>
  );
}
