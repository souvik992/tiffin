import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CreditCard, TriangleAlert } from 'lucide-react';
import type { CheckoutDialogProps } from '../../../ui/src/addonHost.ts';
import { edc, host } from './host.ts';
import type { Machine, Txn } from './host.ts';

const { useSession, Modal, newKey, messageOf } = host;
const formatPaise = host.money.formatPaise;

/** The machines, kept here so the counter can list them without waiting (refreshed on sign-in and every minute). */
let machines: Machine[] = [];
let signedInApi: Parameters<typeof edc>[0] | null = null;
export function loadMachines(api: Parameters<typeof edc>[0]): void {
  signedInApi = api;
  edc(api).machines().then((l) => { machines = l.filter((m) => m.active); host.refresh(); }).catch(() => { /* none: by hand */ });
}
/** After a reload: a payment still waiting on a machine (or approved without a bill) for this open bill. */
export async function pendingFor(orderId: string) {
  if (!signedInApi) return null;
  const t = await edc(signedInApi).pending(orderId);
  return t ? { mode: (t.mode === 'UPI' ? 'UPI' : 'CARD') as 'UPI' | 'CARD', optionId: t.terminalId, resume: t } : null;
}
export const machineOptions = (mode: string) => (mode === 'CARD' || mode === 'UPI'
  ? machines.filter((m) => m.modes.includes(mode)).map((m) => ({ id: m.id, label: `On machine: ${m.name}`, isDefault: m.isDefault }))
  : []);

/**
 * Card or UPI on a payment machine: sends the bill total, waits for the customer, saves the bill when approved.
 * Nothing unclear is ever called "failed": the cashier is told to look at the machine.
 */
export function MachinePayDialog({ cart, mode, optionId, resume, onClose, onPaid }: CheckoutDialogProps) {
  const { api, notify, withApproval } = useSession();
  const [txn, setTxn] = useState<Txn | null>((resume as Txn | undefined) ?? null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const startKey = useRef(newKey());
  const doneKey = useRef(newKey());
  const completing = useRef(false);
  const m = mode === 'UPI' ? 'UPI' : 'CARD';
  const start = useCallback(async () => {
    setError(''); setTxn(null);
    try { setTxn(await edc(api).start(cart.order.id, m, optionId, startKey.current)); } catch (e) { startKey.current = newKey(); setError(messageOf(e)); }
  }, [api, cart.order.id, m, optionId]);
  useEffect(() => { if (!resume) void start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // waiting: ask the POS every second
  useEffect(() => {
    if (!txn || txn.status !== 'PENDING') return;
    const t = setInterval(() => { edc(api).get(txn.id).then(setTxn).catch(() => { /* next tick */ }); }, 1000);
    return () => clearInterval(t);
  }, [api, txn]);
  // approved: save the bill
  useEffect(() => {
    if (!txn || txn.status !== 'APPROVED' || txn.invoiceId || completing.current) return;
    completing.current = true;
    edc(api).complete(txn.id, doneKey.current).then(onPaid).catch((e) => { setError(messageOf(e)); completing.current = false; });
  }, [api, txn, onPaid]);
  const cancel = async () => {
    if (!txn) return onClose();
    setBusy(true);
    try { setTxn(await edc(api).cancel(txn.id)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const recheck = async () => {
    if (!txn) return;
    setBusy(true);
    try { setTxn(await edc(api).recheck(txn.id)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const reverse = async () => {
    if (!txn) return;
    const key = newKey();
    try { const v = await withApproval('Reversing a machine payment', (o) => edc(api).reverse(txn.id, o, key)); if (v) { notify('info', 'Reversal sent to the machine. Charge the bill again.'); onClose(); } } catch (e) { setError(messageOf(e)); }
  };
  const again = () => { startKey.current = newKey(); doneKey.current = newKey(); completing.current = false; void start(); };
  const st = txn?.status;
  return (
    <Modal title={`${m === 'UPI' ? 'UPI' : 'Card'} on ${txn?.terminalName ?? 'the machine'}`} onClose={st === 'PENDING' ? () => {} : onClose}>
      <p className="text-center text-3xl font-bold tabular-nums text-primary">{formatPaise(txn?.amount ?? cart.totals.grandTotal)}</p>
      <div className="mt-4 min-h-24 rounded-xl border border-border p-4 text-sm" role="status">
        {!txn && !error && <p className="text-center text-muted-foreground">Sending to the machine…</p>}
        {st === 'PENDING' && <div className="text-center"><CreditCard className="mx-auto h-8 w-8 animate-pulse text-primary" /><p className="mt-2 font-semibold">Waiting for the customer on the machine</p><p className="text-muted-foreground">{m === 'UPI' ? 'The customer scans the QR on the machine.' : 'Tap, insert or swipe the card on the machine.'}</p></div>}
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

/** Orders > a bill: its machine payments, and "Reverse on machine" (same day, manager approval). */
export function InvoiceMachinePanel({ invoiceId }: { invoiceId: string }) {
  const { api, notify, withApproval, fail } = useSession();
  const [list, setList] = useState<Txn[]>([]);
  const load = useCallback(() => { edc(api).forInvoice(invoiceId).then(setList).catch(() => setList([])); }, [api, invoiceId]);
  useEffect(load, [load]);
  if (list.length === 0) return null;
  const reversed = list.some((v) => v.kind === 'VOID' && v.status === 'APPROVED');
  const reverse = async (x: Txn) => {
    const key = newKey();
    try {
      const v = await withApproval('Reversing a machine payment', (o) => edc(api).reverse(x.id, o, key));
      if (v) { notify('info', 'Reversal sent to the machine. Check the machine for the reversal slip.'); setTimeout(load, 3000); }
    } catch (e) { fail(e); }
  };
  return (
    <div className="mt-3 rounded-lg border border-border p-3 text-sm">
      <p className="mb-1 text-xs font-semibold">Payment machine</p>
      {list.map((x) => (
        <div key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-0.5">
          <span className="text-muted-foreground">{x.kind === 'VOID' ? `Reversal on ${x.terminalName}: ${x.status === 'APPROVED' ? 'done' : x.status === 'PENDING' ? 'waiting for the machine' : x.message ?? x.status.toLowerCase()}`
            : `${x.terminalName}: ${formatPaise(x.amount)}${x.result?.approvalCode ? ` · Auth ${x.result.approvalCode}` : ''}${x.result?.cardLast4 ? ` · *${x.result.cardLast4}` : ''}`}</span>
          {x.kind === 'SALE' && x.status === 'APPROVED' && !reversed && <button className="btn-ghost h-8 px-2 text-xs text-destructive" onClick={() => void reverse(x)}>Reverse on machine</button>}
        </div>
      ))}
      <p className="mt-1 text-xs text-muted-foreground">Reversing gives the money back on the card or UPI (same day only). Cancel or refund the bill as well.</p>
    </div>
  );
}
