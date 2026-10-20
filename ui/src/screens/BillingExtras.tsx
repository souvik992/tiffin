import { useCallback, useEffect, useRef, useState } from 'react';
import { Banknote, CheckCircle2, CreditCard, Plus, Printer, RotateCw, Smartphone, Trash2, TriangleAlert, Wallet } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { Cart, CartLine, Discount, FinalizeResult, Item, OpenOrder, PayMode, PaymentCheck, PaymentIn, TerminalTxn, ZReport } from '../lib/api.ts';
import { formatPaise, formatQty, formatRateBp, paiseToInput, parsePercentBp, parseQty, parseRupees } from '../lib/money.ts';
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
                <p className="truncate text-xs text-muted-foreground">{[`${o.lineCount} item${o.lineCount === 1 ? '' : 's'}`, o.customerName, o.customerPhone, o.note, o.createdByName, age(o.updatedAt)].filter(Boolean).join(' · ')}</p>
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
  const [name, setName] = useState(cart.order.customerName ?? '');
  const [phone, setPhone] = useState(cart.order.customerPhone ?? '');
  const [note, setNote] = useState(cart.order.note ?? '');
  const [gstin, setGstin] = useState(cart.order.buyerGstin ?? '');
  const [error, setError] = useState('');
  const save = async () => {
    if (phone.trim() && !/^\d{10}$/.test(phone.trim())) return setError('Phone number must be 10 digits.');
    if (gstin.trim() && gstin.trim().length !== 15) return setError('A GSTIN has 15 characters.');
    try {
      const c = await withApproval('Changing this bill', (o) => api.updateOrder(cart.order.id, { customerName: name.trim() || null, customerPhone: phone.trim() || null, note: note.trim() || null, buyerGstin: gstin.trim().toUpperCase() || null }, o, key.current));
      if (c) onSaved(c);
    } catch (e) { key.current = newKey(); setError(messageOf(e)); }
  };
  return (
    <Modal title="Customer and note" onClose={onClose}>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Customer name</span>
        <input className="field" maxLength={60} autoComplete="off" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Customer phone</span>
        <input className="field" inputMode="numeric" maxLength={10} placeholder="10 digits (optional)" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
      </label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Note</span>
        <input className="field" maxLength={200} placeholder="Table 4, less spicy, parcel…" value={note} onChange={(e) => setNote(e.target.value)} />
        <span className="text-xs text-muted-foreground">Printed on the kitchen ticket.</span>
      </label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Customer's GSTIN (business customers)</span>
        <input className="field font-mono uppercase" maxLength={15} placeholder="15 characters (optional)" value={gstin} onChange={(e) => setGstin(e.target.value.replace(/[^0-9A-Za-z]/g, ''))} aria-label="Customer GSTIN" />
        <span className="text-xs text-muted-foreground">Printed on the bill. A GSTIN from another state charges IGST instead of CGST + SGST.</span>
      </label>
      <p className="mt-2 text-xs text-muted-foreground">Name and phone are printed on the bill too.</p>
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

/** One line of the bill: exact quantity (kg items, 2.5 plates), a note for the kitchen and a discount on this line only. */
export function LineDialog({ line, onClose, onSave }: { line: CartLine; onClose: () => void; onSave: (input: { qtyMilli?: number; discount?: Discount | null; note?: string | null }) => Promise<boolean> }) {
  const [qty, setQty] = useState(formatQty(line.qtyMilli));
  const [note, setNote] = useState(line.note ?? '');
  const [discType, setDiscType] = useState<Discount['type']>(line.discount?.type ?? 'percent');
  const [discValue, setDiscValue] = useState(line.discount ? (line.discount.type === 'percent' ? formatRateBp(line.discount.value).replace('%', '') : paiseToInput(line.discount.value)) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const q = parseQty(qty);
    if (q === null || q <= 0) return setError('Enter a quantity, like 2 or 1.5.');
    let discount: Discount | null = null;
    if (discValue.trim()) {
      const v = discType === 'percent' ? parsePercentBp(discValue) : parseRupees(discValue);
      if (v === null || v <= 0) return setError(discType === 'percent' ? 'Enter a percentage between 0 and 100.' : 'Enter an amount in rupees, like 20.');
      discount = { type: discType, value: v };
    }
    setError(''); setBusy(true);
    try { if (await onSave({ qtyMilli: q, discount, note: note.trim() || null })) onClose(); } finally { setBusy(false); }
  };
  return (
    <Modal title={line.name} onClose={onClose}>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Quantity ({line.unit})</span>
        <input className="field" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
      </label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Note for the kitchen</span>
        <input className="field" maxLength={120} placeholder="Less spicy, no onion, extra sauce…" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Line note" autoFocus />
      </label>
      <div className="mt-3 text-sm"><span className="font-medium">Discount on this item</span>
        <div className="mt-1 flex gap-2">
          <div className="flex shrink-0 gap-1.5" role="group" aria-label="Discount type">
            <button type="button" className={`pay-btn h-11 w-11 text-base ${discType === 'percent' ? 'pay-btn-active' : ''}`} aria-label="Percentage discount" onClick={() => setDiscType('percent')}>%</button>
            <button type="button" className={`pay-btn h-11 w-11 text-base ${discType === 'amount' ? 'pay-btn-active' : ''}`} aria-label="Fixed amount discount" onClick={() => setDiscType('amount')}>₹</button>
          </div>
          <input className="field h-11 min-w-0 flex-1" inputMode="decimal" placeholder="None" value={discValue} onChange={(e) => setDiscValue(e.target.value)} aria-label="Line discount" />
          {discValue && <button type="button" className="btn-ghost h-11 shrink-0 px-3" onClick={() => setDiscValue('')}>No discount</button>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{discType === 'amount' ? 'Rupees off this line.' : 'Percent off this line.'} Above your discount limit a manager approves with their PIN.</p>
      </div>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </Modal>
  );
}

/** Shift report (X): the open shift's figures so far, on screen and on the receipt printer. Does not close the shift. */
export function XReportDialog({ onClose }: { onClose: () => void }) {
  const { api, notify, fail } = useSession();
  const [r, setR] = useState<ZReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.xReport().then(setR).catch((e) => { fail(e); onClose(); }); }, [api, fail, onClose]);
  const print = async () => {
    setBusy(true);
    try { await api.printXReport(newKey()); notify('success', 'Shift report sent to the receipt printer.'); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Shift report (X)" onClose={onClose}>
      {!r ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">The shift so far. It stays open; the closing (Z) report is printed when the shift is closed.</p>
          <div className="space-y-1 text-sm tabular-nums">
            <XRow label="Bills" value={String(r.invoices)} />
            <XRow label="Sales" value={formatPaise(r.sales)} />
            {r.discounts > 0 && <XRow label="Discounts" value={formatPaise(r.discounts)} />}
            {r.cancelled > 0 && <XRow label={`Cancelled (${r.cancelled})`} value={formatPaise(r.cancelledAmount)} />}
            {r.creditNotes > 0 && <XRow label={`Refunds (${r.creditNotes})`} value={formatPaise(r.refunds)} />}
            {Object.entries(r.byMode).map(([m, a]) => <XRow key={m} label={MODE_LABEL[m as PayMode] ?? m} value={formatPaise(a)} />)}
            <XRow label="Opening cash" value={formatPaise(r.cash.opening)} />
            <div className="flex justify-between pt-1 font-semibold"><span>Cash that should be in the drawer</span><span>{formatPaise(r.cash.expected)}</span></div>
          </div>
          <button className="btn-primary mt-5 w-full" disabled={busy} onClick={() => void print()}><Printer className="h-4 w-4" />{busy ? 'Sending…' : 'Print'}</button>
        </>
      )}
    </Modal>
  );
}
function XRow({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-muted-foreground"><span>{label}</span><span className="text-foreground">{value}</span></div>;
}

/** Opens the cash drawer without a sale. A manager approves; the reason is recorded. */
export function DrawerDialog({ onClose }: { onClose: () => void }) {
  const { api, notify, withApproval } = useSession();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const go = async (r: string) => {
    if (r.trim().length < 2) return setError('Say why the drawer is opened.');
    setBusy(true); setError('');
    try {
      const out = await withApproval('Opening the cash drawer', (o) => api.openDrawer(r.trim(), o, key.current));
      if (out) { notify('success', 'Cash drawer opened.'); onClose(); }
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Open cash drawer" onClose={onClose}>
      <p className="text-sm text-muted-foreground">Recorded with your name and the reason. A manager approves.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {['Change for a customer', 'Cash count', 'Cash taken to the bank'].map((x) => <button key={x} className="chip" disabled={busy} onClick={() => void go(x)}>{x}</button>)}
      </div>
      <input className="field mt-3 w-full" maxLength={120} placeholder="Or type a reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" onKeyDown={(e) => { if (e.key === 'Enter') void go(reason); }} />
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={() => void go(reason)}>{busy ? 'Opening…' : 'Open drawer'}</button>
    </Modal>
  );
}

/** Sold out today: items marked here come back by themselves tomorrow. */
export function AvailabilityDialog({ items, onToggle, onClose }: { items: Item[]; onToggle: (item: Item, available: boolean) => Promise<void>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const shown = items.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()));
  const off = items.filter((i) => i.availableToday === false).length;
  return (
    <Modal title="Sold out today" onClose={onClose} width="max-w-lg">
      <p className="mb-3 text-sm text-muted-foreground">Tap an item to mark it sold out. It is greyed out on billing and hidden from online orders, and comes back by itself tomorrow.{off ? ` ${off} sold out now.` : ''}</p>
      <input className="field mb-3 w-full" placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" autoFocus />
      <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-xl border border-border">
        {shown.map((i) => {
          const soldOut = i.availableToday === false;
          return (
            <li key={i.id}>
              <button className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-secondary disabled:opacity-60" disabled={busy !== null} onClick={async () => { setBusy(i.id); try { await onToggle(i, soldOut); } finally { setBusy(null); } }}>
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${soldOut ? 'bg-destructive text-destructive-foreground' : 'bg-veg/15 text-veg'}`}>{busy === i.id ? '…' : soldOut ? 'Sold out' : 'Available'}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/**
 * Card or UPI on a payment machine: sends the bill total, waits for the customer, saves the bill when approved.
 * Nothing unclear is ever called "failed": the cashier is told to look at the machine.
 */
export function MachinePayDialog({ cart, mode, terminalId, resume, onClose, onPaid }: { cart: Cart; mode: 'CARD' | 'UPI'; terminalId: string | null; resume?: TerminalTxn | null; onClose: () => void; onPaid: (r: FinalizeResult) => void }) {
  const { api, notify, withApproval } = useSession();
  const [txn, setTxn] = useState<TerminalTxn | null>(resume ?? null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const startKey = useRef(newKey());
  const doneKey = useRef(newKey());
  const completing = useRef(false);
  const start = useCallback(async () => {
    setError(''); setTxn(null);
    try { setTxn(await api.startTerminalCharge(cart.order.id, mode, terminalId, startKey.current)); } catch (e) { startKey.current = newKey(); setError(messageOf(e)); }
  }, [api, cart.order.id, mode, terminalId]);
  useEffect(() => { if (!resume) void start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // waiting: ask the POS every second
  useEffect(() => {
    if (!txn || txn.status !== 'PENDING') return;
    const t = setInterval(() => { api.terminalCharge(txn.id).then(setTxn).catch(() => { /* next tick */ }); }, 1000);
    return () => clearInterval(t);
  }, [api, txn]);
  // approved: save the bill
  useEffect(() => {
    if (!txn || txn.status !== 'APPROVED' || txn.invoiceId || completing.current) return;
    completing.current = true;
    api.completeTerminalCharge(txn.id, doneKey.current).then(onPaid).catch((e) => { setError(messageOf(e)); completing.current = false; });
  }, [api, txn, onPaid]);
  const cancel = async () => {
    if (!txn) return onClose();
    setBusy(true);
    try { setTxn(await api.cancelTerminalCharge(txn.id)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const recheck = async () => {
    if (!txn) return;
    setBusy(true);
    try { setTxn(await api.recheckTerminalCharge(txn.id)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const reverse = async () => {
    if (!txn) return;
    const key = newKey();
    try { const v = await withApproval('Reversing a machine payment', (o) => api.voidTerminalCharge(txn.id, o, key)); if (v) { notify('info', 'Reversal sent to the machine. Charge the bill again.'); onClose(); } } catch (e) { setError(messageOf(e)); }
  };
  const again = () => { startKey.current = newKey(); doneKey.current = newKey(); completing.current = false; void start(); };
  const what = mode === 'UPI' ? 'UPI' : 'Card';
  const st = txn?.status;
  return (
    <Modal title={`${what} on ${txn?.terminalName ?? 'the machine'}`} onClose={st === 'PENDING' ? () => {} : onClose}>
      <p className="text-center text-3xl font-bold tabular-nums text-primary">{formatPaise(txn?.amount ?? cart.totals.grandTotal)}</p>
      <div className="mt-4 min-h-24 rounded-xl border border-border p-4 text-sm" role="status">
        {!txn && !error && <p className="text-center text-muted-foreground">Sending to the machine…</p>}
        {st === 'PENDING' && <div className="text-center"><CreditCard className="mx-auto h-8 w-8 animate-pulse text-primary" /><p className="mt-2 font-semibold">Waiting for the customer on the machine</p><p className="text-muted-foreground">{mode === 'UPI' ? 'The customer scans the QR on the machine.' : 'Tap, insert or swipe the card on the machine.'}</p></div>}
        {st === 'APPROVED' && <div className="text-center"><CheckCircle2 className="mx-auto h-8 w-8 text-veg" /><p className="mt-2 font-semibold">Approved{txn?.result?.approvalCode ? ` · ${txn.result.approvalCode}` : ''}</p><p className="text-muted-foreground">{error ? '' : 'Saving the bill…'}</p></div>}
        {(st === 'FAILED' || st === 'CANCELLED') && <div className="text-center"><TriangleAlert className="mx-auto h-8 w-8 text-destructive" /><p className="mt-2 font-semibold">{st === 'CANCELLED' ? 'Cancelled' : 'Not approved'}</p><p className="text-muted-foreground">{txn?.message}</p></div>}
        {st === 'UNKNOWN' && <div className="text-center"><TriangleAlert className="mx-auto h-8 w-8 text-primary" /><p className="mt-2 font-semibold">Check the machine</p><p className="text-muted-foreground">{txn?.message} If the machine shows approved, close this and pay by hand with the slip's approval code.</p></div>}
        {error && <p className="mt-2 text-center text-destructive" role="alert">{error}</p>}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {st === 'PENDING' && (txn?.canCancel ? <button className="btn-ghost" disabled={busy} onClick={() => void cancel()}>{busy ? 'Cancelling…' : 'Cancel payment'}</button> : <p className="text-xs text-muted-foreground">To stop, press Cancel on the machine.</p>)}
        {st === 'UNKNOWN' && txn?.connection === 'cloud' && <button className="btn-ghost" disabled={busy} onClick={() => void recheck()}>Check again</button>}
        {st === 'APPROVED' && error && <button className="btn-ghost text-destructive" onClick={() => void reverse()}>Reverse on the machine</button>}
        {(st === 'FAILED' || st === 'CANCELLED' || (!txn && error)) && <button className="btn-primary" onClick={again}>Try again</button>}
        {st !== 'PENDING' && <button className="btn-ghost" onClick={onClose}>Close</button>}
      </div>
    </Modal>
  );
}
