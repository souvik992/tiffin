import { useEffect, useRef, useState } from 'react';
import { Banknote, CheckCircle2, CreditCard, Plus, Printer, RotateCw, Smartphone, Trash2, TriangleAlert, Wallet } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { Cart, FinalizeResult, OpenOrder, PayMode, PaymentCheck, PaymentIn } from '../lib/api.ts';
import { formatPaise, paiseToInput, parseRupees } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';
import { PrintStatus, ReceiptDialog } from '../components/print.tsx';

export const MODE_LABEL: Record<PayMode, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', WALLET: 'Wallet', CREDIT: 'Credit (pay later)', OTHER: 'Other' };
const MODE_ICON: Partial<Record<PayMode, typeof Banknote>> = { CASH: Banknote, UPI: Smartphone, CARD: CreditCard, WALLET: Wallet };
const SPLIT_MODES: PayMode[] = ['CASH', 'UPI', 'CARD', 'WALLET', 'OTHER'];

interface Row { key: number; mode: PayMode; amount: string; tendered: string; reference: string }

/**
 * Split payment: several modes for one bill (for example part UPI, part cash). The backend checks the split and
 * says what is left to pay and the change; this screen never adds money up itself.
 */
export function SplitPaymentDialog({ cart, payKey, onClose, onPaid }: { cart: Cart; payKey: { current: { orderId: string; key: string } | null }; onClose: () => void; onPaid: (r: FinalizeResult) => void }) {
  const { api } = useSession();
  const seq = useRef(2);
  const [rows, setRows] = useState<Row[]>([{ key: 1, mode: 'UPI', amount: '', tendered: '', reference: '' }]);
  const [check, setCheck] = useState<PaymentCheck | null>(null);
  const checkSeq = useRef(0);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');

  const toPayments = (rs: Row[]): { payments: PaymentIn[]; bad: string | null } => {
    const payments: PaymentIn[] = [];
    for (const r of rs) {
      if (!r.amount.trim()) continue;
      const amount = parseRupees(r.amount);
      if (amount === null || amount <= 0) return { payments, bad: 'Amounts are in rupees, like 150 or 99.50.' };
      const tendered = r.mode === 'CASH' && r.tendered.trim() ? parseRupees(r.tendered) : null;
      if (r.mode === 'CASH' && r.tendered.trim() && tendered === null) return { payments, bad: 'Cash received is in rupees, like 500.' };
      payments.push({ mode: r.mode, amount, tendered, reference: r.mode === 'CASH' ? null : r.reference.trim() || null });
    }
    return { payments, bad: null };
  };
  const parsed = toPayments(rows);
  const parsedKey = JSON.stringify(parsed);

  useEffect(() => {
    if (parsed.bad) { setCheck(null); return; }
    const mine = ++checkSeq.current; // only the newest answer may update the screen
    const t = setTimeout(() => { api.checkPayments(cart.order.id, parsed.payments).then((r) => { if (mine === checkSeq.current) setCheck(r); }).catch(() => { if (mine === checkSeq.current) setCheck(null); }); }, 200);
    return () => clearTimeout(t);
  }, [api, cart.order.id, parsedKey]);

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // "Fill the rest" uses the remaining amount the backend reported (only for an empty row).
  const fillRest = (key: number) => { if (check && check.remaining > 0) set(key, { amount: paiseToInput(check.remaining) }); };

  const pay = async () => {
    if (!check?.ok || parsed.bad || paying) return;
    if (!payKey.current || payKey.current.orderId !== cart.order.id) payKey.current = { orderId: cart.order.id, key: newKey() };
    setPaying(true); setError('');
    try {
      const r = await api.finalize(cart.order.id, parsed.payments, payKey.current.key);
      payKey.current = null;
      onPaid(r);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'NETWORK')) payKey.current = null;
      setError(messageOf(e));
    } finally { setPaying(false); }
  };

  return (
    <Modal title="Split payment" onClose={onClose} width="max-w-xl">
      <p className="mb-3 text-sm text-muted-foreground">Bill total <b className="text-foreground">{formatPaise(cart.totals.grandTotal)}</b>. Add each way the customer pays.</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={r.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-2">
            <select className="field w-36" aria-label={`Payment ${i + 1} mode`} value={r.mode} onChange={(e) => set(r.key, { mode: e.target.value as PayMode })}>
              {SPLIT_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
            <input className="field w-28" inputMode="decimal" placeholder="Amount ₹" aria-label={`Payment ${i + 1} amount`} value={r.amount} onChange={(e) => set(r.key, { amount: e.target.value })} />
            {!r.amount.trim() && check && check.remaining > 0 && <button type="button" className="text-xs font-semibold text-primary" onClick={() => fillRest(r.key)}>Rest: {formatPaise(check.remaining)}</button>}
            {r.mode === 'CASH'
              ? <input className="field w-32" inputMode="decimal" placeholder="Cash received" aria-label={`Payment ${i + 1} cash received`} value={r.tendered} onChange={(e) => set(r.key, { tendered: e.target.value })} />
              : <input className="field w-36" maxLength={60} placeholder="Reference" aria-label={`Payment ${i + 1} reference`} value={r.reference} onChange={(e) => set(r.key, { reference: e.target.value })} />}
            {rows.length > 1 && <button type="button" className="rail-btn ml-auto h-9 w-9" aria-label={`Remove payment ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" /></button>}
          </div>
        ))}
      </div>
      {rows.length < 6 && <button type="button" className="btn-ghost mt-2" onClick={() => setRows((rs) => [...rs, { key: seq.current++, mode: 'CASH', amount: '', tendered: '', reference: '' }])}><Plus className="h-4 w-4" />Add another payment</button>}
      <div className="mt-4 space-y-1 rounded-xl bg-secondary/60 p-3 text-sm tabular-nums">
        <div className="flex justify-between"><span>Paid</span><span>{check ? formatPaise(check.paid) : '—'}</span></div>
        {check && check.remaining > 0 && <div className="flex justify-between font-semibold text-destructive"><span>Still to pay</span><span>{formatPaise(check.remaining)}</span></div>}
        {check && check.remaining < 0 && <div className="flex justify-between font-semibold text-destructive"><span>Too much by</span><span>{formatPaise(-check.remaining)}</span></div>}
        {check && check.changeDue > 0 && <div className="flex justify-between font-semibold"><span>Change to give</span><span>{formatPaise(check.changeDue)}</span></div>}
        {(parsed.bad || check?.message) && <p className="text-xs text-destructive">{parsed.bad ?? check?.message}</p>}
      </div>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 h-12 w-full text-base" disabled={!check?.ok || !!parsed.bad || paying} onClick={() => void pay()}>
        {paying ? 'Saving bill…' : check?.ok ? `Complete bill ${formatPaise(cart.totals.grandTotal)}` : 'Payments must add up to the bill'}
      </button>
    </Modal>
  );
}

/** Shown after a bill is saved: the change to give, what printed, and on-screen printing or reprint. */
export function AfterPayment({ result, onDone }: { result: FinalizeResult; onDone: () => void }) {
  const { api, fail, notify, withApproval } = useSession();
  const [showReceipt, setShowReceipt] = useState(false);
  const [statusKey, setStatusKey] = useState(0);
  const iv = result.invoice;
  const reprint = async () => {
    const key = newKey();
    try {
      const r = await withApproval('Reprinting a bill', (o) => api.reprint(iv.id, o, key));
      if (r) { notify(r.queued ? 'success' : 'error', r.queued ? 'Reprint sent to the receipt printer.' : 'No receipt printer is set up. Print it from the screen instead.'); setStatusKey((k) => k + 1); }
    } catch (e) { fail(e); }
  };
  const retry = async (jobId: string) => { try { await api.retryPrintJob(jobId); setStatusKey((k) => k + 1); } catch (e) { fail(e); } };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3" aria-live="polite">
      <div className="rounded-2xl border border-success/40 bg-success/5 p-4">
        <p className="flex items-center gap-2 font-semibold text-success"><CheckCircle2 className="h-5 w-5" />Bill saved</p>
        <p className="mt-1 font-display text-lg">{iv.invoiceNo}</p>
        <p className="text-sm text-muted-foreground">{iv.tokenNo ? `Token ${iv.tokenNo} · ` : ''}{formatPaise(iv.grandTotal)} · {result.payments.map((p) => MODE_LABEL[p.mode]).join(' + ') || 'No payment (zero bill)'}</p>
        {result.changeDue > 0 && (
          <div className="mt-3 rounded-xl bg-card p-3 text-center">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Change to give</p>
            <p className="font-display text-3xl text-primary">{formatPaise(result.changeDue)}</p>
          </div>
        )}
      </div>
      <div className="mt-3 rounded-xl border border-border p-3">
        <p className="mb-1.5 text-sm font-semibold">Printing</p>
        {result.print.warnings.includes('NO_RECEIPT_PRINTER') && (
          <p className="mb-1.5 flex items-start gap-1.5 text-xs text-destructive"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />No receipt printer is set up. Print from the screen, or add one in Settings.</p>
        )}
        {result.print.warnings.includes('NO_KITCHEN_PRINTER') && (
          <p className="mb-1.5 flex items-start gap-1.5 text-xs text-destructive"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />No kitchen printer matches some items. Tell the kitchen, or set kitchen stations in Settings.</p>
        )}
        <PrintStatus key={statusKey} invoiceId={iv.id} onRetry={(id) => void retry(id)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button className="btn-ghost" onClick={() => setShowReceipt(true)}><Printer className="h-4 w-4" />Print on screen</button>
        <button className="btn-ghost" onClick={() => void reprint()}><RotateCw className="h-4 w-4" />Reprint</button>
      </div>
      <button className="btn-primary mt-3 h-12 w-full text-base" onClick={onDone} autoFocus>New bill</button>
      {showReceipt && <ReceiptDialog invoiceId={iv.id} title={`Receipt ${iv.invoiceNo}`} onClose={() => setShowReceipt(false)} />}
    </div>
  );
}

/** Held (parked) bills: resume one to keep billing it. */
export function HeldBillsDialog({ onClose, onResume }: { onClose: () => void; onResume: (id: string) => void }) {
  const { api, fail } = useSession();
  const [list, setList] = useState<OpenOrder[] | null>(null);
  useEffect(() => { api.openOrders('HELD').then(setList).catch((e) => { setList([]); fail(e); }); }, [api, fail]);
  const age = (ms: number) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60_000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  return (
    <Modal title="Held bills" onClose={onClose} width="max-w-lg">
      {list === null ? <p className="text-sm text-muted-foreground">Loading…</p> : list.length === 0 ? <p className="text-sm text-muted-foreground">No bills on hold.</p> : (
        <ul className="divide-y divide-border">
          {list.map((o) => (
            <li key={o.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">Token {o.tokenNo} · {formatPaise(o.grandTotal)}</p>
                <p className="truncate text-xs text-muted-foreground">{[`${o.lineCount} item${o.lineCount === 1 ? '' : 's'}`, o.customerPhone, o.note, o.createdByName, age(o.updatedAt)].filter(Boolean).join(' · ')}</p>
              </div>
              <button className="btn-primary h-9" onClick={() => onResume(o.id)}>Resume</button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Customer phone and a note for the kitchen or the bill. */
export function CustomerDialog({ cart, onClose, onSaved }: { cart: Cart; onClose: () => void; onSaved: (c: Cart) => void }) {
  const { api, withApproval } = useSession();
  const key = useRef(newKey());
  const [phone, setPhone] = useState(cart.order.customerPhone ?? '');
  const [note, setNote] = useState(cart.order.note ?? '');
  const [error, setError] = useState('');
  const save = async () => {
    if (phone.trim() && !/^\d{10}$/.test(phone.trim())) return setError('Phone number must be 10 digits.');
    try {
      const c = await withApproval('Changing this bill', (o) => api.updateOrder(cart.order.id, { customerPhone: phone.trim() || null, note: note.trim() || null }, o, key.current));
      if (c) onSaved(c);
    } catch (e) { key.current = newKey(); setError(messageOf(e)); }
  };
  return (
    <Modal title="Customer and note" onClose={onClose}>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Customer phone</span>
        <input className="field" inputMode="numeric" maxLength={10} placeholder="10 digits (optional)" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} autoFocus />
      </label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Note</span>
        <input className="field" maxLength={200} placeholder="Table 4, less spicy, parcel…" value={note} onChange={(e) => setNote(e.target.value)} />
        <span className="text-xs text-muted-foreground">Printed on the kitchen ticket.</span>
      </label>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full" onClick={() => void save()}>Save</button>
    </Modal>
  );
}

export function ConfirmDialog({ title, text, confirm, onConfirm, onClose }: { title: string; text: string; confirm: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-muted-foreground">{text}</p>
      <div className="mt-5 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose} autoFocus>Keep</button>
        <button className="btn-primary flex-1 bg-destructive" onClick={onConfirm}>{confirm}</button>
      </div>
    </Modal>
  );
}

export { MODE_ICON };
