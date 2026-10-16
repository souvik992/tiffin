import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { PurchaseDetail, PurchaseLineIn, PurchasePreview, PurchaseSummary, StockItem } from '../lib/api.ts';
import { formatPaise, formatStockQty, parseQty, parseRupees, unitLabel } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal, PageShell } from '../components/ui.tsx';

interface Row { key: number; stockItemId: string; qty: string; rate: string }
const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const day = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

export function Purchases() {
  const { api, user, fail } = useSession();
  const canEdit = user?.role === 'manager' || user?.role === 'owner';
  const [rows, setRows] = useState<PurchaseSummary[] | null>(null);
  const [materials, setMaterials] = useState<StockItem[]>([]);
  const [open, setOpen] = useState<PurchaseDetail | null>(null);

  const load = useCallback(() => {
    api.purchases(200).then(setRows).catch((e) => { setRows([]); fail(e); });
    api.stockItems().then(setMaterials).catch(fail);
  }, [api, fail]);
  useEffect(load, [load]);

  const show = async (id: string) => { try { setOpen(await api.purchase(id)); } catch (e) { fail(e); } };

  return (
    <PageShell route="purchases" title="Purchase" subtitle="Record what you bought from suppliers. Stock updates automatically.">
      {canEdit ? <PurchaseForm materials={materials} onSaved={load} /> : <p className="mb-6 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Only a manager or owner can record purchases.</p>}
      <table className="table">
        <thead className="bg-muted text-left">
          <tr><th className="p-3">Date</th><th>Supplier</th><th>Bill #</th><th>Materials</th><th>Status</th><th className="pr-3 text-right">Cost</th></tr>
        </thead>
        <tbody>
          {rows === null && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
          {rows?.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No purchases yet.</td></tr>}
          {rows?.map((p) => (
            <tr key={p.id} className="cursor-pointer border-t border-border hover:bg-secondary/60" tabIndex={0} onClick={() => void show(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') void show(p.id); }}>
              <td className="p-3">{p.billDate ?? day(p.createdAt)}</td>
              <td>{p.supplierName}</td>
              <td>{p.billNo ?? '—'}</td>
              <td className="max-w-xs truncate" title={p.items}>{p.items}</td>
              <td>{p.status === 'VOIDED' ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">Voided</span> : <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">Posted</span>}</td>
              <td className={`pr-3 text-right tabular-nums ${p.status === 'VOIDED' ? 'text-muted-foreground line-through' : ''}`}>{formatPaise(p.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <PurchaseDialog detail={open} canEdit={canEdit} onClose={() => setOpen(null)} onVoided={(d) => { setOpen(d); load(); }} />}
    </PageShell>
  );
}

function PurchaseForm({ materials, onSaved }: { materials: StockItem[]; onSaved: () => void }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const seq = useRef(1);
  const blank = (): Row => ({ key: seq.current++, stockItemId: '', qty: '', rate: '' });
  const [supplier, setSupplier] = useState('');
  const [gstin, setGstin] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(todayIst());
  const [lines, setLines] = useState<Row[]>(() => [blank()]);
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Parsed lines, or null while any line is incomplete.
  const parsed: PurchaseLineIn[] | null = (() => {
    const out: PurchaseLineIn[] = [];
    for (const r of lines) {
      const q = parseQty(r.qty), c = parseRupees(r.rate);
      if (!r.stockItemId || q === null || q === 0 || c === null) return null;
      out.push({ stockItemId: r.stockItemId, qtyMilli: q, unitCost: c });
    }
    return out;
  })();
  const parsedKey = JSON.stringify(parsed);

  // Amounts come from the backend (the UI never multiplies money).
  useEffect(() => {
    if (!parsed) { setPreview(null); return; }
    const t = setTimeout(() => { api.previewPurchase(parsed).then(setPreview).catch(() => setPreview(null)); }, 250);
    return () => clearTimeout(t);
  }, [api, parsedKey]);

  const setRow = (k: number, patch: Partial<Row>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const amountFor = (i: number) => (preview && parsed && preview.lines[i] ? formatPaise(preview.lines[i]!.amount) : '—');

  const save = async () => {
    if (!supplier.trim()) return setError('Enter the supplier.');
    if (!parsed) return setError('Each line needs a material, a quantity and a rate in rupees.');
    setBusy(true); setError('');
    try {
      const r = await api.createPurchase({ supplierName: supplier.trim(), supplierGstin: gstin.trim() || null, billNo: billNo.trim() || null, billDate: billDate || null, note: null, lines: parsed }, key.current);
      key.current = newKey();
      notify('success', `Purchase from ${r.purchase.supplierName} saved: ${formatPaise(r.purchase.total)}. Stock updated.`);
      setLines([blank()]); setBillNo(''); setPreview(null);
      onSaved();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mb-6 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <input className="field" placeholder="Supplier" aria-label="Supplier" maxLength={80} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        <input className="field w-36" placeholder="Bill no. (optional)" aria-label="Supplier bill number" maxLength={40} value={billNo} onChange={(e) => setBillNo(e.target.value)} />
        <input className="field w-40" type="date" aria-label="Bill date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
        <input className="field w-56 uppercase placeholder:normal-case" placeholder="Supplier GSTIN (optional)" aria-label="Supplier GSTIN" maxLength={15} value={gstin} onChange={(e) => setGstin(e.target.value)} />
      </div>
      {materials.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Add materials on the Stock screen first.</p>}
      <div className="mt-3 space-y-2">
        {lines.map((r, i) => {
          const m = materials.find((x) => x.id === r.stockItemId);
          const u = m ? unitLabel(m.unit) : 'unit';
          return (
            <div key={r.key} className="flex flex-wrap items-center gap-2">
              <select className="field w-56" aria-label={`Line ${i + 1} material`} value={r.stockItemId} onChange={(e) => setRow(r.key, { stockItemId: e.target.value })}>
                <option value="">Select material</option>
                {materials.map((x) => <option key={x.id} value={x.id} disabled={x.id !== r.stockItemId && lines.some((l) => l.stockItemId === x.id)}>{x.name} ({unitLabel(x.unit)})</option>)}
              </select>
              <input className="field w-28" placeholder={`Qty (${u})`} aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} />
              <input className="field w-36" placeholder={`Rate ₹ / ${u}`} aria-label={`Line ${i + 1} rate in rupees`} inputMode="decimal" value={r.rate} onChange={(e) => setRow(r.key, { rate: e.target.value })} />
              <span className="w-28 text-right text-sm tabular-nums" aria-label={`Line ${i + 1} amount`}>{amountFor(i)}</span>
              {lines.length > 1 && <button className="rail-btn h-9 w-9" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((l) => l.key !== r.key))}><Trash2 className="h-4 w-4" /></button>}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button className="btn-ghost" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="h-4 w-4" />Add line</button>
        <span className="ml-auto text-sm">Total <span className="ml-2 text-base font-bold text-primary tabular-nums">{preview && parsed ? formatPaise(preview.total) : '—'}</span></span>
        <button className="btn-primary" disabled={busy || materials.length === 0} onClick={() => void save()}>{busy ? 'Saving…' : 'Save purchase'}</button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

function PurchaseDialog({ detail, canEdit, onClose, onVoided }: { detail: PurchaseDetail; canEdit: boolean; onClose: () => void; onVoided: (d: PurchaseDetail) => void }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const p = detail.purchase;
  const doVoid = async () => {
    if (!reason.trim()) return setError('Give a reason for voiding.');
    try { const d = await api.voidPurchase(p.id, reason.trim(), key.current); notify('success', 'Purchase voided. Its stock was removed again.'); onVoided(d); setConfirming(false); } catch (e) { key.current = newKey(); setError(messageOf(e)); }
  };
  return (
    <Modal title={`Purchase from ${p.supplierName}`} onClose={onClose} width="max-w-lg">
      <p className="mb-3 text-sm text-muted-foreground">{[p.billNo && `Bill ${p.billNo}`, p.billDate, p.supplierGstin && `GSTIN ${p.supplierGstin}`, p.createdByName && `entered by ${p.createdByName}`].filter(Boolean).join(' · ')}</p>
      <ul className="divide-y divide-border text-sm">
        {detail.lines.map((l) => (
          <li key={l.id} className="flex justify-between gap-3 py-1.5">
            <span>{l.name} <span className="text-muted-foreground">{formatStockQty(l.qtyMilli, l.unit)} × {formatPaise(l.unitCost)}</span></span>
            <span className="tabular-nums">{formatPaise(l.amount)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-between border-t border-border pt-2 text-base font-bold"><span>Total</span><span className="text-primary">{formatPaise(p.total)}</span></div>
      {p.status === 'VOIDED' && <p className="mt-3 text-sm text-destructive">Voided{p.voidReason ? `: ${p.voidReason}` : ''}</p>}
      {p.status === 'POSTED' && canEdit && !confirming && <button className="btn-ghost mt-5 w-full text-destructive" onClick={() => setConfirming(true)}>Void this purchase</button>}
      {confirming && (
        <div className="mt-4 rounded-lg border border-destructive/30 p-3">
          <p className="mb-2 text-sm">Voiding removes this stock again and keeps the record. Enter it again if needed.</p>
          <input className="field w-full" maxLength={200} placeholder="Reason" aria-label="Reason for voiding" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
          <button className="btn-primary mt-3 w-full bg-destructive" onClick={() => void doVoid()}>Void purchase</button>
        </div>
      )}
    </Modal>
  );
}
