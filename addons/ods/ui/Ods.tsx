import { useEffect, useRef, useState } from 'react';
import { Bike, CheckCircle2, ChefHat, CircleAlert, Clock, Inbox, PackageCheck, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import { BASE, host } from './host.ts';
import { CHANNEL_LABELS, useOnlineConfig } from './online.ts';
import type { Order } from '../../../contract/src/types.ts';
import type { OrderState } from '../../../contract/src/order.ts';

const { PageShell, Modal, useSession, newKey, messageOf, money } = host;

interface LocalOrder { id: string; number: string; state: OrderState; order: Order; billInvoiceId: string | null; billNo: string | null; billTotal: number | null; alert: string | null; updatedAt: number; posPrice: { total: number; differs: boolean; problem: string | null } | null }
interface Link { paired: boolean; hubUrl: string | null; store: { slug: string; name: string } | null; state: 'off' | 'not-paired' | 'connecting' | 'connected' | 'retrying'; lastError: string | null; accepting: boolean }
interface View { link: Link; orders: LocalOrder[] }

const COLUMNS: Array<{ title: string; states: OrderState[]; icon: typeof Inbox }> = [
  { title: 'New', states: ['SENT_TO_STORE', 'RECEIVED'], icon: Inbox },
  { title: 'Preparing', states: ['ACCEPTED', 'PREPARING'], icon: ChefHat },
  { title: 'Ready', states: ['READY'], icon: PackageCheck },
  { title: 'On the way', states: ['OUT_FOR_DELIVERY'], icon: Bike },
];
const DONE: OrderState[] = ['DELIVERED', 'PICKED_UP', 'REJECTED', 'AUTO_REJECTED', 'CANCELLED'];
const DONE_LABEL: Partial<Record<OrderState, string>> = { DELIVERED: 'Delivered', PICKED_UP: 'Collected', REJECTED: 'Rejected', AUTO_REJECTED: 'Missed (not accepted in time)', CANCELLED: 'Cancelled' };
const REASONS: Array<[string, string]> = [['ITEM_UNAVAILABLE', 'An item is not available'], ['TOO_BUSY', 'Too busy right now'], ['CLOSING', 'Closing soon'], ['OUT_OF_DELIVERY_AREA', 'Address too far'], ['OTHER', 'Other reason']];
const PREP = [10, 15, 20, 30, 45, 60];

/** A short beep for new orders (no sound file needed). */
function beep() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    [0, 0.25].forEach((t) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15); });
    setTimeout(() => void ctx.close(), 800);
  } catch { /* no sound available */ }
}
const ago = (ms: number) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60_000)); return m < 1 ? 'just now' : `${m} min ago`; };

/** ODS: online orders live, by stage. */
export function Ods() {
  const online = useOnlineConfig();
  const { notify } = useSession();
  const [view, setView] = useState<View | null>(null);
  const [live, setLive] = useState(false);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('ods.sound') !== 'off'; } catch { return true; } });
  const [, tick] = useState(0);
  const seen = useRef<Set<string> | null>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  useEffect(() => {
    if (!host.stream) { notify('error', 'Update the POS to use the live ODS.'); return; }
    return host.stream(`${BASE}/events`, (type, data) => {
      if (type !== 'ods') return;
      const v = data as View;
      const fresh = v.orders.filter((o) => (o.state === 'SENT_TO_STORE' || o.state === 'RECEIVED') && !o.billInvoiceId).map((o) => o.id);
      if (seen.current && fresh.some((id) => !seen.current!.has(id)) && soundRef.current) beep();
      seen.current = new Set(fresh);
      setView(v);
    }, setLive);
  }, [notify]);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15_000); return () => clearInterval(t); }, []); // countdowns

  const channels = online ? (Object.keys(CHANNEL_LABELS) as Array<keyof typeof CHANNEL_LABELS>).filter((c) => online.channels[c]).map((c) => CHANNEL_LABELS[c]) : [];
  const link = view?.link;
  const conn = !link ? 'Loading…' : !link.paired ? 'Not connected to an order hub' : link.state === 'connected' ? `Connected to the order hub${link.store ? ` (${link.store.name})` : ''}` : link.state === 'retrying' ? `Reconnecting… ${link.lastError ?? ''}` : 'Connecting…';
  const done = (view?.orders ?? []).filter((o) => DONE.includes(o.state)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);

  return (
    <PageShell route="ods" title="ODS" subtitle="Online orders, live.">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${link?.state === 'connected' && live ? 'bg-veg/15 text-veg' : 'bg-destructive/10 text-destructive'}`}>
          {link?.state === 'connected' && live ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{conn}
        </span>
        {channels.map((c) => <span key={c} className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-primary">{c}</span>)}
        <button className="btn-ghost ml-auto h-9" onClick={() => { const v = !sound; setSound(v); try { localStorage.setItem('ods.sound', v ? 'on' : 'off'); } catch { /* ignore */ } if (v) beep(); }} aria-label={sound ? 'Sound on' : 'Sound off'}>
          {sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}{sound ? 'Sound on' : 'Sound off'}
        </button>
      </div>
      {link && !link.paired && <p className="mb-3 rounded-xl border border-border bg-card p-3 text-sm">Connect this POS to your order hub in <b>Settings &gt; Online orders &gt; Order hub</b>.</p>}
      {link?.paired && !link.accepting && <p role="alert" className="mb-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">No shift is open, so customers cannot order online right now. Open a shift on the Billing screen.</p>}
      <div className="grid gap-3 xl:grid-cols-4 lg:grid-cols-2">
        {COLUMNS.map(({ title, states, icon: Icon }) => {
          const list = (view?.orders ?? []).filter((o) => states.includes(o.state));
          return (
            <section key={title} className="min-h-[55vh] rounded-2xl border border-border bg-card p-3" aria-label={title}>
              <h2 className="mb-2 flex items-center gap-2 font-semibold"><Icon className="h-4 w-4 text-primary" />{title}<span className="ml-auto rounded-full bg-muted px-2 text-xs">{list.length}</span></h2>
              {list.length === 0 && <p className="mt-8 text-center text-sm text-muted-foreground">No orders.</p>}
              <div className="space-y-3">{list.map((o) => <OrderCard key={o.id} o={o} acceptMode={online?.acceptMode ?? 'manual'} />)}</div>
            </section>
          );
        })}
      </div>
      {done.length > 0 && (
        <section className="mt-4 rounded-2xl border border-border bg-card p-3" aria-label="Finished">
          <h2 className="mb-2 font-semibold">Finished recently</h2>
          <ul className="divide-y divide-border text-sm">
            {done.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 py-2">
                <b>{o.number}</b><span className="text-muted-foreground">{DONE_LABEL[o.state]}</span>
                {o.billNo && <span className="text-xs text-muted-foreground">Bill {o.billNo}</span>}
                <span className="ml-auto tabular-nums">{money.formatPaise(o.billTotal ?? o.order.total)}</span>
                {o.alert && <AlertActions o={o} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

function OrderCard({ o, acceptMode }: { o: LocalOrder; acceptMode: 'manual' | 'auto' }) {
  const { api, fail, notify, withApproval } = useSession();
  const d = o.order;
  const [prep, setPrep] = useState(d.fulfilment === 'PICKUP' ? 15 : 20);
  const [dialog, setDialog] = useState<'reject' | 'rider' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = (o.state === 'SENT_TO_STORE' || o.state === 'RECEIVED') && !o.billInvoiceId;
  const left = d.acceptBy ? Math.max(0, Math.round((d.acceptBy - Date.now()) / 1000)) : null;
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notify('success', ok); } catch (e) { fail(e); } finally { setBusy(false); } };
  const step = (to: OrderState, extra: Record<string, unknown> = {}) => act(() => api.request('POST', `${BASE}/orders/${encodeURIComponent(o.id)}/step`, { to, ...extra }, newKey()));
  const accept = (acceptPriceChange = false) => act(() => api.request('POST', `${BASE}/orders/${encodeURIComponent(o.id)}/accept`, { prepMinutes: prep, acceptPriceChange }, newKey()), `${o.number} accepted: bill and kitchen ticket sent to the printer.`);

  return (
    <article className={`rounded-xl border p-3 text-sm ${isNew ? 'border-primary bg-accent/40' : 'border-border bg-background'}`} aria-label={`Order ${o.number}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <b className="text-base">{o.number}</b>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{CHANNEL_LABELS[d.channel as keyof typeof CHANNEL_LABELS] ?? d.channel}</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{d.fulfilment === 'DELIVERY' ? `Delivery${d.distanceKm !== null ? ` · ${d.distanceKm} km` : ''}` : 'Pickup'}</span>
        <span className="ml-auto text-xs text-muted-foreground">{ago(d.placedAt)}</span>
      </div>
      {isNew && left !== null && acceptMode === 'manual' && <p className={`mb-1 flex items-center gap-1 text-xs font-semibold ${left < 60 ? 'text-destructive' : 'text-primary'}`}><Clock className="h-3.5 w-3.5" />Accept within {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>}
      <p className="font-medium">{d.customer.name ?? 'Customer'} · {d.customer.mobile}{d.customer.verified ? ' ✓' : ''}</p>
      {d.address && <p className="text-xs text-muted-foreground">{d.address.line1}{d.address.landmark ? `, ${d.address.landmark}` : ''}, {d.address.city} {d.address.pincode}</p>}
      <ul className="my-2 space-y-0.5">
        {d.lines.map((l, i) => (
          <li key={i} className="flex gap-2"><span className="tabular-nums">{l.qtyMilli / 1000} ×</span><span className="flex-1">{l.name}{l.modifiers.length ? <span className="text-xs text-muted-foreground"> + {l.modifiers.map((m) => m.name).join(', ')}</span> : null}{l.note ? <span className="block text-xs italic">“{l.note}”</span> : null}</span><span className="tabular-nums">{money.formatPaise(l.lineTotal)}</span></li>
        ))}
      </ul>
      {d.note && <p className="mb-1 text-xs italic">Note: “{d.note}”</p>}
      <div className="border-t border-border pt-1 text-xs">
        {d.deliveryFee > 0 && <div className="flex justify-between"><span>Delivery</span><span>{money.formatPaise(d.deliveryFee)}</span></div>}
        {d.packagingFee > 0 && <div className="flex justify-between"><span>Packaging</span><span>{money.formatPaise(d.packagingFee)}</span></div>}
        <div className="flex justify-between text-sm font-semibold"><span>{d.payment === 'COD' ? `Collect ${d.fulfilment === 'DELIVERY' ? 'on delivery' : 'at pickup'}` : 'Paid online'}</span><span>{money.formatPaise(o.billTotal ?? d.total)}</span></div>
        {o.billNo && <div className="text-muted-foreground">Bill {o.billNo}{d.prepMinutes ? ` · ready in ${d.prepMinutes} min` : ''}</div>}
        {d.rider && <div className="text-muted-foreground">Rider: {d.rider.name}{d.rider.phone ? ` (${d.rider.phone})` : ''}</div>}
      </div>
      {o.posPrice?.differs && <p role="alert" className="mt-2 flex gap-1 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"><CircleAlert className="h-4 w-4 shrink-0" />{o.posPrice.problem ?? `Price changed since ordering: POS price ${money.formatPaise(o.posPrice.total)}, customer was charged ${money.formatPaise(d.total)}.`}</p>}
      {o.alert && <div className="mt-2 rounded-lg bg-primary/10 p-2 text-xs text-primary"><p className="flex gap-1"><CircleAlert className="h-4 w-4 shrink-0" />{o.alert}</p><AlertActions o={o} /></div>}

      <div className="mt-2 flex flex-wrap gap-2">
        {isNew && (
          <>
            <select className="field h-9" value={prep} onChange={(e) => setPrep(Number(e.target.value))} aria-label={`Preparation time for ${o.number}`}>{PREP.map((m) => <option key={m} value={m}>{m} min</option>)}</select>
            {o.posPrice?.differs
              ? <button className="btn-primary h-9" disabled={busy || Boolean(o.posPrice.problem)} onClick={() => void accept(true)}>Accept at POS price</button>
              : <button className="btn-primary h-9" disabled={busy} onClick={() => void accept()}><CheckCircle2 className="h-4 w-4" />Accept</button>}
            <button className="btn-ghost h-9" disabled={busy} onClick={() => setDialog('reject')}>Reject</button>
          </>
        )}
        {o.state === 'ACCEPTED' && <button className="btn-primary h-9" disabled={busy} onClick={() => void step('PREPARING')}>Start preparing</button>}
        {(o.state === 'ACCEPTED' || o.state === 'PREPARING') && <button className={o.state === 'PREPARING' ? 'btn-primary h-9' : 'btn-ghost h-9'} disabled={busy} onClick={() => void step('READY')}>Ready</button>}
        {o.state === 'READY' && d.fulfilment === 'PICKUP' && <button className="btn-primary h-9" disabled={busy} onClick={() => void step('PICKED_UP')}>Collected</button>}
        {o.state === 'READY' && d.fulfilment === 'DELIVERY' && <button className="btn-primary h-9" disabled={busy} onClick={() => setDialog('rider')}><Bike className="h-4 w-4" />Send with rider</button>}
        {o.state === 'OUT_FOR_DELIVERY' && <button className="btn-primary h-9" disabled={busy} onClick={() => void step('DELIVERED')}>Delivered</button>}
        {['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'].includes(o.state) && <button className="btn-ghost h-9" disabled={busy} onClick={() => setDialog('cancel')}>Cancel</button>}
      </div>

      {dialog === 'reject' && <ReasonDialog title={`Reject ${o.number}?`} reasons onClose={() => setDialog(null)} onDone={(reason, text) => void act(() => api.request('POST', `${BASE}/orders/${encodeURIComponent(o.id)}/reject`, { reason, reasonText: text }, newKey()), `${o.number} rejected. The customer is told.`).then(() => setDialog(null))} />}
      {dialog === 'cancel' && <ReasonDialog title={`Cancel ${o.number}?`} note={`The bill ${o.billNo ?? ''} is cancelled too (a manager approves).`} onClose={() => setDialog(null)} onDone={(_r, text) => {
        const key = newKey();
        void act(() => withApproval(`Cancel online order ${o.number}`, (override) => api.request('POST', `${BASE}/orders/${encodeURIComponent(o.id)}/step`, { to: 'CANCELLED', reasonText: text, override }, key)), `${o.number} cancelled.`).then(() => setDialog(null));
      }} />}
      {dialog === 'rider' && <RiderDialog number={o.number} onClose={() => setDialog(null)} onDone={(rider) => void step('OUT_FOR_DELIVERY', { rider }).then(() => setDialog(null))} />}
    </article>
  );
}

/** "Cancel bill" after the customer cancelled first (F11): the bill is cancelled with a manager's approval. */
function AlertActions({ o }: { o: LocalOrder }) {
  const { api, fail, notify, withApproval } = useSession();
  if (!o.billInvoiceId || !/Cancel bill/.test(o.alert ?? '')) return null;
  const go = () => {
    const key = newKey();
    void withApproval(`Cancel bill ${o.billNo}`, (override) => api.request('POST', `${BASE}/orders/${encodeURIComponent(o.id)}/step`, { to: 'CANCELLED', reasonText: 'Customer cancelled before the store accepted', override }, key))
      .then((r) => { if (r) notify('success', `Bill ${o.billNo} cancelled.`); }).catch(fail);
  };
  return <button className="btn-ghost mt-1 h-8 text-xs" onClick={go}>Cancel bill {o.billNo}</button>;
}

function ReasonDialog({ title, note, reasons, onClose, onDone }: { title: string; note?: string; reasons?: boolean; onClose: () => void; onDone: (reason: string, text: string) => void }) {
  const [reason, setReason] = useState(reasons ? 'ITEM_UNAVAILABLE' : 'OTHER');
  const [text, setText] = useState('');
  const needText = !reasons || reason === 'OTHER';
  return (
    <Modal title={title} onClose={onClose}>
      {note && <p className="mb-3 text-sm text-muted-foreground">{note}</p>}
      {reasons && <div className="mb-3 space-y-1" role="radiogroup">{REASONS.map(([k, label]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} />{label}</label>)}</div>}
      <label className="block text-sm font-medium">{needText ? 'Reason (the customer sees this)' : 'Message for the customer (optional)'}
        <input className="field mt-1 w-full" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reason" autoFocus />
      </label>
      <div className="mt-4 flex gap-2"><button className="btn-ghost flex-1" onClick={onClose}>Back</button><button className="btn-primary flex-1 bg-destructive" disabled={needText && !text.trim()} onClick={() => onDone(reason, text.trim())}>Confirm</button></div>
    </Modal>
  );
}

function RiderDialog({ number, onClose, onDone }: { number: string; onClose: () => void; onDone: (r: { name: string; phone: string | null }) => void }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem('ods.rider') ?? ''; } catch { return ''; } });
  const [phone, setPhone] = useState('');
  return (
    <Modal title={`Send ${number} with a rider`} onClose={onClose}>
      <label className="block text-sm font-medium">Rider name<input className="field mt-1 w-full" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-label="Rider name" autoFocus /></label>
      <label className="mt-3 block text-sm font-medium">Rider phone (the customer sees it)<input className="field mt-1 w-full" inputMode="numeric" maxLength={15} value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Rider phone" /></label>
      <div className="mt-4 flex gap-2"><button className="btn-ghost flex-1" onClick={onClose}>Back</button><button className="btn-primary flex-1" disabled={!name.trim()} onClick={() => { try { localStorage.setItem('ods.rider', name.trim()); } catch { /* ignore */ } onDone({ name: name.trim(), phone: phone.trim() || null }); }}>Out for delivery</button></div>
    </Modal>
  );
}
