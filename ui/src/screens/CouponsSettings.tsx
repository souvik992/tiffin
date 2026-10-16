import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Coupon, CouponInput } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';
import { formatPaise, formatRateBp, paiseToInput, parsePercentBp, parseRupees } from '../lib/money.ts';

const STATUS: Record<Coupon['status'], [string, string]> = {
  active: ['Active', 'bg-primary/15 text-primary'],
  off: ['Off', 'bg-muted'],
  not_started: ['Not started', 'bg-muted'],
  expired: ['Ended', 'bg-muted'],
  used_up: ['Used up', 'bg-destructive/15 text-destructive'],
};
const off = (c: Coupon) => (c.type === 'percent' ? `${formatRateBp(c.value)} off${c.maxDiscount ? `, up to ${formatPaise(c.maxDiscount)}` : ''}` : `${formatPaise(c.value)} off`);

/** Settings > Coupons (owner only): create, edit and switch off codes. Cashiers type the code on the bill. */
export function CouponsSettings() {
  const { api, fail, notify } = useSession();
  const [list, setList] = useState<Coupon[] | null>(null);
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const load = useCallback(() => api.coupons().then(setList).catch((e) => { setList([]); fail(e); }), [api, fail]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="font-display text-2xl">Coupons</h2>
        <button className="btn-primary ml-auto" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add coupon</button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Codes customers can use. On the Billing screen, tap the % button, choose <b>Coupon code</b> and type the code. A coupon needs no manager PIN: the owner approved it here. Only the owner sees this page.</p>
      <table className="table">
        <thead className="bg-muted text-left">
          <tr><th className="p-3">Code</th><th>Takes off</th><th>Minimum bill</th><th>Valid</th><th>Used</th><th>Status</th><th className="pr-3" /></tr>
        </thead>
        <tbody>
          {list === null && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
          {list?.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No coupons yet.</td></tr>}
          {list?.map((c) => (
            <tr key={c.id} className={`border-t border-border ${c.status === 'active' ? '' : 'text-muted-foreground'}`}>
              <td className="p-3"><span className="font-mono font-semibold">{c.code}</span>{c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}</td>
              <td>{off(c)}</td>
              <td className="tabular-nums">{c.minBill ? formatPaise(c.minBill) : '—'}</td>
              <td className="text-xs">{c.validFrom || c.validTo ? `${c.validFrom ?? 'now'} to ${c.validTo ?? 'no end'}` : 'Always'}</td>
              <td className="tabular-nums">{c.uses}{c.maxUses ? ` of ${c.maxUses}` : ''}</td>
              <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></td>
              <td className="pr-3 text-right"><button className="btn-ghost h-9 px-3" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" />Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <CouponDialog coupon={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onDone={(c) => { setEditing(null); notify('success', `Coupon ${c.code} saved.`); void load(); }} />}
    </>
  );
}

function CouponDialog({ coupon, onClose, onDone }: { coupon: Coupon | null; onClose: () => void; onDone: (c: Coupon) => void }) {
  const { api } = useSession();
  const key = useRef(newKey());
  const [code, setCode] = useState(coupon?.code ?? '');
  const [description, setDescription] = useState(coupon?.description ?? '');
  const [type, setType] = useState<Coupon['type']>(coupon?.type ?? 'percent');
  const [value, setValue] = useState(coupon ? (coupon.type === 'percent' ? String(coupon.value / 100) : paiseToInput(coupon.value)) : '');
  const [cap, setCap] = useState(coupon?.maxDiscount ? paiseToInput(coupon.maxDiscount) : '');
  const [minBill, setMinBill] = useState(coupon?.minBill ? paiseToInput(coupon.minBill) : '');
  const [from, setFrom] = useState(coupon?.validFrom ?? '');
  const [to, setTo] = useState(coupon?.validTo ?? '');
  const [maxUses, setMaxUses] = useState(coupon?.maxUses ? String(coupon.maxUses) : '');
  const [active, setActive] = useState(coupon?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    const v = type === 'percent' ? parsePercentBp(value) : parseRupees(value);
    if (v === null || v <= 0) return setError(type === 'percent' ? 'Enter the percentage, like 10.' : 'Enter the amount in rupees, like 50.');
    const capP = cap.trim() ? parseRupees(cap) : null;
    if (cap.trim() && (capP === null || capP <= 0)) return setError('Maximum discount must be an amount in rupees.');
    const minP = minBill.trim() ? parseRupees(minBill) : 0;
    if (minP === null) return setError('Minimum bill must be an amount in rupees.');
    const uses = maxUses.trim() ? Number(maxUses) : null;
    if (uses !== null && (!Number.isInteger(uses) || uses < 1)) return setError('Number of uses must be a whole number (empty = no limit).');
    const input: CouponInput = { code: code.trim().toUpperCase(), description: description.trim() || null, type, value: v, maxDiscount: type === 'percent' ? capP : null, minBill: minP, validFrom: from || null, validTo: to || null, maxUses: uses, active };
    setBusy(true);
    try {
      const c = coupon ? await api.updateCoupon(coupon.id, input, key.current) : await api.createCoupon(input, key.current);
      onDone(c);
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={coupon ? `Edit coupon ${coupon.code}` : 'Add coupon'} onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">Code
            <input className="field mt-1 w-full font-mono uppercase" maxLength={20} value={code} disabled={Boolean(coupon && coupon.uses > 0)} onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))} placeholder="SAVE10" aria-label="Coupon code" autoFocus />
          </label>
          <label className="block text-sm font-medium">Note (optional)
            <input className="field mt-1 w-full" maxLength={80} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Diwali offer" aria-label="Note" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="text-sm font-medium">Takes off
            <div className="mt-1 flex gap-1.5">
              <button type="button" className={`pay-btn h-10 w-12 ${type === 'percent' ? 'pay-btn-active' : ''}`} onClick={() => setType('percent')} aria-label="Percentage">%</button>
              <button type="button" className={`pay-btn h-10 w-12 ${type === 'amount' ? 'pay-btn-active' : ''}`} onClick={() => setType('amount')} aria-label="Amount">₹</button>
              <input className="field h-10 min-w-0 flex-1" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={type === 'percent' ? '10' : '50'} aria-label="How much" />
            </div>
          </div>
          {type === 'percent' && (
            <label className="block text-sm font-medium">Up to (₹, optional)
              <input className="field mt-1 w-full" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="no limit" aria-label="Maximum discount" />
            </label>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">Minimum bill (₹)
            <input className="field mt-1 w-full" inputMode="decimal" value={minBill} onChange={(e) => setMinBill(e.target.value)} placeholder="none" aria-label="Minimum bill" />
          </label>
          <label className="block text-sm font-medium">Number of uses
            <input className="field mt-1 w-full" inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))} placeholder="no limit" aria-label="Number of uses" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium">From (optional)
            <input className="field mt-1 w-full" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Valid from" />
          </label>
          <label className="block text-sm font-medium">To (optional)
            <input className="field mt-1 w-full" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Valid to" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Active (can be used)</label>
        <p className="text-xs text-muted-foreground">The minimum bill is the bill total before the coupon. A used coupon keeps its code; to replace it, switch it off and add a new one.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2"><button className="btn-ghost flex-1" onClick={onClose}>Cancel</button><button className="btn-primary flex-1" disabled={busy || code.trim().length < 3} onClick={() => void save()}>{busy ? 'Saving…' : 'Save coupon'}</button></div>
      </div>
    </Modal>
  );
}
