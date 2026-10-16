import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Monitor, Printer, Undo2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { CreditOption, CreditPreview, InvoiceDetail, InvoiceSummary, PayMode } from '../lib/api.ts';
import { formatPaise, formatQty } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal, PageShell } from '../components/ui.tsx';
import { PrintStatus, ReceiptDialog } from '../components/print.tsx';
import { MODE_LABEL } from './BillingExtras.tsx';

const IST_OFFSET_MS = 330 * 60_000;
/** Start of today in India (bills are dated in IST whatever the PC clock zone is). Date arithmetic, not money. */
function istDayStart(now = Date.now()): number {
  const ist = now + IST_OFFSET_MS;
  return ist - (ist % 86_400_000) - IST_OFFSET_MS;
}
const time = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Orders() {
  const { api, fail, notify, withApproval } = useSession();
  const [range, setRange] = useState<'today' | 'recent'>('today');
  const [rows, setRows] = useState<InvoiceSummary[] | null>(null);
  const [open, setOpen] = useState<InvoiceDetail | null>(null);
  const [screenPrint, setScreenPrint] = useState<InvoiceDetail | null>(null);
  const [cancelling, setCancelling] = useState<InvoiceDetail | null>(null);
  const [refunding, setRefunding] = useState<InvoiceDetail | null>(null);
  const [statusKey, setStatusKey] = useState(0);

  const load = useCallback(() => {
    setRows(null);
    api.invoices(range === 'today' ? { fromMs: istDayStart(), limit: 200 } : { limit: 200 }).then(setRows).catch((e) => { setRows([]); fail(e); });
  }, [api, fail, range]);
  useEffect(load, [load]);

  const show = async (id: string) => { try { setOpen(await api.invoice(id)); } catch (e) { fail(e); } };
  const reprint = async (id: string) => {
    const key = newKey();
    try {
      const r = await withApproval('Reprinting a bill', (o) => api.reprint(id, o, key));
      if (r) { notify(r.queued ? 'success' : 'error', r.queued ? 'Reprint sent to the receipt printer.' : 'No receipt printer is set up. Use Print on screen.'); setStatusKey((k) => k + 1); }
    } catch (e) { fail(e); }
  };

  return (
    <PageShell route="orders" title="Orders" subtitle="Bills completed on this counter.">
      <div className="mb-4 flex gap-2">
        <button className={`chip ${range === 'today' ? 'chip-active' : ''}`} onClick={() => setRange('today')}>Today</button>
        <button className={`chip ${range === 'recent' ? 'chip-active' : ''}`} onClick={() => setRange('recent')}>Last 200</button>
      </div>
      <table className="table">
        <thead className="bg-muted text-left">
          <tr><th className="p-3">Bill #</th><th>Time</th><th>Token</th><th>Cashier</th><th>Status</th><th className="pr-3 text-right">Total</th></tr>
        </thead>
        <tbody>
          {rows === null && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
          {rows?.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No orders yet. Complete a bill on the billing screen.</td></tr>}
          {rows?.map((r) => (
            <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-secondary/60" onClick={() => void show(r.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') void show(r.id); }}>
              <td className="p-3 font-medium">{r.invoiceNo}{r.docType === 'CREDIT_NOTE' && <span className="ml-2 text-xs text-muted-foreground">credit note</span>}</td>
              <td>{time(r.issuedAt)}</td>
              <td>{r.tokenNo ?? '—'}</td>
              <td>{r.cashierName}</td>
              <td>{r.status === 'CANCELLED' ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">Cancelled</span> : <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">Paid</span>}</td>
              <td className="pr-3 text-right tabular-nums">{formatPaise(r.grandTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Modal title={`Bill ${open.invoice.invoiceNo}`} onClose={() => setOpen(null)} width="max-w-lg">
          <p className="mb-3 text-sm text-muted-foreground">{time(open.invoice.issuedAt)} · {open.invoice.cashierName}{open.invoice.tokenNo ? ` · Token ${open.invoice.tokenNo}` : ''}</p>
          <ul className="divide-y divide-border text-sm">
            {open.lines.map((l) => (
              <li key={l.id} className="flex justify-between gap-3 py-1.5">
                <span>{formatQty(l.qtyMilli)} × {l.name}{l.modifiers.length > 0 && <span className="block text-xs text-muted-foreground">+ {l.modifiers.map((m) => m.name).join(', ')}</span>}</span>
                <span className="tabular-nums">{formatPaise(l.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 space-y-0.5 border-t border-border pt-2 text-sm tabular-nums">
            {open.invoice.discountTotal > 0 && <Line label="Discount" value={`−${formatPaise(open.invoice.discountTotal)}`} />}
            {open.invoice.cgst > 0 && <Line label="CGST" value={formatPaise(open.invoice.cgst)} />}
            {open.invoice.sgst > 0 && <Line label="SGST" value={formatPaise(open.invoice.sgst)} />}
            {open.invoice.igst > 0 && <Line label="IGST" value={formatPaise(open.invoice.igst)} />}
            {open.invoice.roundOff !== 0 && <Line label="Round off" value={formatPaise(open.invoice.roundOff)} />}
            <div className="flex justify-between pt-1 text-base font-bold"><span>Total</span><span className="text-primary">{formatPaise(open.invoice.grandTotal)}</span></div>
            {open.payments.map((p) => <Line key={p.id} label={`Paid by ${p.mode.toLowerCase()}${p.reference ? ` (${p.reference})` : ''}`} value={formatPaise(p.amount)} />)}
          </div>
          {open.invoice.status === 'CANCELLED' && <p className="mt-3 text-sm text-destructive">Cancelled{open.invoice.cancelReason ? `: ${open.invoice.cancelReason}` : ''}</p>}
          <div className="mt-4 rounded-lg border border-border p-3"><p className="mb-1 text-xs font-semibold">Printing</p><PrintStatus key={statusKey} invoiceId={open.invoice.id} onRetry={(id) => { void api.retryPrintJob(id).then(() => setStatusKey((k) => k + 1)).catch(fail); }} /></div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="btn-ghost" onClick={() => setScreenPrint(open)}><Monitor className="h-4 w-4" />Print on screen</button>
            <button className="btn-ghost" onClick={() => void reprint(open.invoice.id)}><Printer className="h-4 w-4" />Reprint</button>
            {open.invoice.docType === 'TAX_INVOICE' && open.invoice.status === 'ISSUED' && <>
              <button className="btn-ghost" onClick={() => setRefunding(open)}><Undo2 className="h-4 w-4" />Refund items</button>
              <button className="btn-ghost text-destructive" onClick={() => setCancelling(open)}><Ban className="h-4 w-4" />Cancel bill</button>
            </>}
          </div>
        </Modal>
      )}
      {screenPrint && <ReceiptDialog invoiceId={screenPrint.invoice.id} title={`Receipt ${screenPrint.invoice.invoiceNo}`} onClose={() => setScreenPrint(null)} />}
      {cancelling && <CancelDialog detail={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); setOpen(null); load(); }} />}
      {refunding && <RefundDialog detail={refunding} onClose={() => setRefunding(null)} onDone={() => { setRefunding(null); setOpen(null); load(); }} />}
    </PageShell>
  );
}

/** Cancel a bill made by mistake: same day, while its shift is open, with a reason and a manager's approval. */
function CancelDialog({ detail, onClose, onDone }: { detail: InvoiceDetail; onClose: () => void; onDone: () => void }) {
  const { api, notify, withApproval } = useSession();
  const key = useRef(newKey());
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!reason.trim()) return setError('Give a reason, like "wrong items billed".');
    setBusy(true); setError('');
    try {
      const r = await withApproval('Cancelling a bill', (o) => api.cancelInvoice(detail.invoice.id, reason.trim(), o, key.current));
      if (r) { notify('success', `Bill ${detail.invoice.invoiceNo} cancelled. Its money is removed from today's totals.`); onDone(); }
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Cancel ${detail.invoice.invoiceNo}?`} onClose={onClose}>
      <p className="text-sm text-muted-foreground">Only for a bill made by mistake today, while its shift is open. Return the money ({formatPaise(detail.invoice.grandTotal)}) to the customer. For food already served, use Refund items instead.</p>
      <input className="field mt-3 w-full" maxLength={200} placeholder="Reason" aria-label="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full bg-destructive" disabled={busy} onClick={() => void go()}>{busy ? 'Cancelling…' : 'Cancel bill'}</button>
    </Modal>
  );
}

const REFUND_MODES: PayMode[] = ['CASH', 'UPI', 'CARD'];

/** Refund some or all items as a credit note. The refund amount comes from the backend (same calculation as the note). */
function RefundDialog({ detail, onClose, onDone }: { detail: InvoiceDetail; onClose: () => void; onDone: () => void }) {
  const { api, fail, notify, withApproval } = useSession();
  const key = useRef(newKey());
  const [options, setOptions] = useState<CreditOption[] | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<CreditPreview | null>(null);
  const [mode, setMode] = useState<PayMode>(detail.payments[0]?.mode && REFUND_MODES.includes(detail.payments[0].mode) ? detail.payments[0].mode : 'CASH');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { api.creditOptions(detail.invoice.id).then((r) => setOptions(r.lines)).catch((e) => { fail(e); closeRef.current(); }); }, [api, fail, detail.invoice.id]);
  const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([invoiceLineId, qtyMilli]) => ({ invoiceLineId, qtyMilli }));
  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    if (lines.length === 0) { setPreview(null); return; }
    api.previewCredit(detail.invoice.id, lines).then((p) => { setPreview(p); setError(''); }).catch((e) => { setPreview(null); setError(messageOf(e)); });
  }, [api, detail.invoice.id, linesKey]);
  const step = (o: CreditOption, d: 1 | -1) => setQty((q) => {
    const cur = q[o.invoiceLineId] ?? 0;
    const unit = Math.min(1000, o.remainingQtyMilli);
    const next = Math.max(0, Math.min(o.remainingQtyMilli, cur + d * unit));
    return { ...q, [o.invoiceLineId]: next };
  });
  const all = () => setQty(Object.fromEntries((options ?? []).map((o) => [o.invoiceLineId, o.remainingQtyMilli])));
  const go = async () => {
    if (!preview) return setError('Choose what to refund.');
    if (!reason.trim()) return setError('Give a reason, like "customer returned it".');
    setBusy(true); setError('');
    try {
      const r = await withApproval('A refund', (o) => api.createCredit(detail.invoice.id, { lines, reason: reason.trim(), refunds: [{ mode, amount: preview.total }] }, o, key.current));
      if (r) { notify('success', `Refund ${r.invoice.invoiceNo}: give back ${formatPaise(r.invoice.grandTotal)} by ${MODE_LABEL[mode]}.`); onDone(); }
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Refund from ${detail.invoice.invoiceNo}`} onClose={onClose} width="max-w-lg">
      {!options ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <div className="mb-2 flex items-center"><p className="text-sm text-muted-foreground">Choose how many of each item to refund.</p><button className="ml-auto text-sm font-semibold text-primary" onClick={all}>Refund everything left</button></div>
          <ul className="divide-y divide-border text-sm">
            {options.map((o) => (
              <li key={o.invoiceLineId} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1"><span className="block truncate">{o.name}</span><span className="text-xs text-muted-foreground">{o.remainingQtyMilli > 0 ? `${formatQty(o.remainingQtyMilli)} of ${formatQty(o.soldQtyMilli)} can be refunded` : 'Already refunded'}</span></span>
                <button className="qty-btn" aria-label={`One less ${o.name}`} disabled={!(qty[o.invoiceLineId] ?? 0)} onClick={() => step(o, -1)}>−</button>
                <span className="w-10 text-center font-semibold tabular-nums">{formatQty(qty[o.invoiceLineId] ?? 0)}</span>
                <button className="qty-btn" aria-label={`One more ${o.name}`} disabled={(qty[o.invoiceLineId] ?? 0) >= o.remainingQtyMilli} onClick={() => step(o, 1)}>+</button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-secondary/60 p-3 text-base font-bold"><span>Refund</span><span className="text-primary">{preview ? formatPaise(preview.total) : '—'}</span></div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm"><span>Give back by</span>{REFUND_MODES.map((m) => <button key={m} className={`chip ${mode === m ? 'chip-active' : ''}`} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>)}</div>
          <input className="field mt-3 w-full" maxLength={200} placeholder="Reason" aria-label="Reason for the refund" value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">Refunded food is not added back to stock.</p>
          {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
          <button className="btn-primary mt-4 w-full" disabled={busy || !preview} onClick={() => void go()}>{busy ? 'Saving…' : preview ? `Refund ${formatPaise(preview.total)}` : 'Refund'}</button>
        </>
      )}
    </Modal>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-muted-foreground"><span>{label}</span><span className="text-foreground">{value}</span></div>;
}
