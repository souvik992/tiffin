import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { History, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { MovementKind, StockItem, StockMovement, StockUnit } from '../lib/api.ts';
import { formatPaise, formatQty, formatStockQty, parseQty, parseRupees, unitLabel } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal, PageShell } from '../components/ui.tsx';

const UNITS: StockUnit[] = ['kg', 'g', 'l', 'ml', 'pcs'];
const KIND_LABEL: Record<MovementKind, string> = {
  OPENING: 'Opening stock', PURCHASE: 'Purchase', PURCHASE_VOID: 'Purchase voided', SALE: 'Sold (recipe)',
  SALE_REVERSAL: 'Bill cancelled', WASTAGE: 'Wastage', COUNT: 'Physical count', ADJUST: 'Correction',
};
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Stock() {
  const { api, user, fail, notify } = useSession();
  const canEdit = user?.role === 'manager' || user?.role === 'owner';
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'low'>('all');
  const [adjusting, setAdjusting] = useState<StockItem | null>(null);
  const [history, setHistory] = useState<StockItem | null>(null);
  const [editing, setEditing] = useState<StockItem | null>(null);
  const [deleting, setDeleting] = useState<StockItem | null>(null);

  const load = useCallback(() => api.stockItems().then(setItems).catch((e) => { setItems([]); fail(e); }), [api, fail]);
  useEffect(() => { void load(); }, [load]);

  const shown = (items ?? []).filter((i) => filter === 'all' || i.low || i.negative);
  const lowCount = (items ?? []).filter((i) => i.low || i.negative).length;

  const remove = async (it: StockItem) => {
    try { await api.deleteStockItem(it.id); notify('success', `${it.name} removed. Its history is kept.`); await load(); } catch (e) { fail(e); } finally { setDeleting(null); }
  };

  return (
    <PageShell route="stock" title="Stock" subtitle="Current raw material levels. Purchases add to stock and bills use it up through recipes.">
      {canEdit && <AddMaterial onAdded={load} />}
      <div className="mb-4 flex items-center gap-2">
        <button className={`chip ${filter === 'all' ? 'chip-active' : ''}`} onClick={() => setFilter('all')}>All materials</button>
        <button className={`chip ${filter === 'low' ? 'chip-active' : ''}`} onClick={() => setFilter('low')}>Needs attention{lowCount ? ` (${lowCount})` : ''}</button>
      </div>
      <table className="table">
        <thead className="bg-muted text-left">
          <tr><th className="p-3">Material</th><th>In stock</th><th>Reorder at</th><th>Status</th><th className="text-right">Last cost</th><th className="text-right">Value</th><th className="w-40 pr-3 text-right">Actions</th></tr>
        </thead>
        <tbody>
          {items === null && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
          {items !== null && shown.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">{filter === 'low' ? 'Nothing is low. Good.' : 'No materials yet. Add your first one above.'}</td></tr>}
          {shown.map((i) => (
            <tr key={i.id} className="border-t border-border">
              <td className="p-3 font-medium">{i.name}</td>
              <td className={`tabular-nums ${i.negative ? 'font-semibold text-destructive' : ''}`}>{formatStockQty(i.onHandMilli, i.unit)}</td>
              <td className="tabular-nums text-muted-foreground">{i.reorderLevelMilli > 0 ? formatStockQty(i.reorderLevelMilli, i.unit) : '—'}</td>
              <td>
                {i.negative ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive" title="More was used than recorded. Do a physical count.">Count needed</span>
                  : i.low ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">Low</span>
                  : <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">OK</span>}
              </td>
              <td className="text-right tabular-nums">{i.lastUnitCost !== null ? `${formatPaise(i.lastUnitCost)} / ${unitLabel(i.unit)}` : '—'}</td>
              <td className="text-right tabular-nums">{i.lastUnitCost !== null ? formatPaise(i.valuePaise) : '—'}</td>
              <td className="pr-2">
                <div className="flex justify-end gap-1">
                  {canEdit && <IconBtn label={`Adjust ${i.name}`} onClick={() => setAdjusting(i)}><SlidersHorizontal className="h-4 w-4" /></IconBtn>}
                  <IconBtn label={`History of ${i.name}`} onClick={() => setHistory(i)}><History className="h-4 w-4" /></IconBtn>
                  {canEdit && <IconBtn label={`Edit ${i.name}`} onClick={() => setEditing(i)}><Pencil className="h-4 w-4" /></IconBtn>}
                  {canEdit && <IconBtn label={`Remove ${i.name}`} onClick={() => setDeleting(i)}><Trash2 className="h-4 w-4" /></IconBtn>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!canEdit && <p className="mt-4 text-sm text-muted-foreground">Only a manager or owner can add materials or change stock.</p>}

      {adjusting && <AdjustDialog item={adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); void load(); }} />}
      {history && <HistoryDialog item={history} onClose={() => setHistory(null)} />}
      {editing && <EditDialog item={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void load(); }} />}
      {deleting && (
        <Modal title="Remove material?" onClose={() => setDeleting(null)}>
          <p className="text-sm text-muted-foreground">{deleting.name} will no longer appear in stock or purchases. Its history is kept for audit.</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setDeleting(null)}>Keep</button>
            <button className="btn-primary flex-1 bg-destructive" onClick={() => void remove(deleting)}>Remove</button>
          </div>
        </Modal>
      )}
    </PageShell>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button className="rail-btn h-9 w-9" aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function AddMaterial({ onAdded }: { onAdded: () => void }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<StockUnit>('kg');
  const [reorder, setReorder] = useState('');
  const [opening, setOpening] = useState('');
  const [cost, setCost] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const reorderMilli = reorder.trim() ? parseQty(reorder) : 0;
    const openingMilli = opening.trim() ? parseQty(opening) : 0;
    const costPaise = cost.trim() ? parseRupees(cost) : null;
    if (!name.trim()) return setError('Enter the material name.');
    if (reorderMilli === null || openingMilli === null) return setError(`Quantities are in ${unitLabel(unit)}, like 5 or 2.5.`);
    if (cost.trim() && costPaise === null) return setError('Cost is in rupees, like 56 or 56.50.');
    setBusy(true); setError('');
    try {
      await api.createStockItem({ name: name.trim(), unit, reorderLevelMilli: reorderMilli, openingQtyMilli: openingMilli, openingUnitCost: costPaise }, key.current);
      key.current = newKey();
      notify('success', `${name.trim()} added to stock.`);
      setName(''); setReorder(''); setOpening(''); setCost('');
      onAdded();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
      <input className="field" placeholder="Material name" aria-label="Material name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <select className="field" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)}>
        {UNITS.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}
      </select>
      <input className="field w-32" placeholder={`Reorder at (${unitLabel(unit)})`} aria-label="Reorder level" inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} />
      <input className="field w-40" placeholder={`Opening stock (${unitLabel(unit)})`} aria-label="Opening stock" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
      <input className="field w-36" placeholder={`Cost ₹ / ${unitLabel(unit)}`} aria-label="Cost per unit in rupees (optional)" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
      <button className="btn-primary" disabled={busy} onClick={() => void add()}>Add material</button>
      {error && <span className="text-sm text-destructive" role="alert">{error}</span>}
    </div>
  );
}

type AdjustKind = 'WASTAGE' | 'COUNT' | 'ADJUST';
function AdjustDialog({ item, onClose, onDone }: { item: StockItem; onClose: () => void; onDone: () => void }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [kind, setKind] = useState<AdjustKind>('WASTAGE');
  const [sign, setSign] = useState<1 | -1>(1);
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const u = unitLabel(item.unit);
  const submit = async () => {
    const milli = parseQty(qty);
    if (milli === null || (kind !== 'COUNT' && milli === 0)) return setError(`Enter a quantity in ${u}, like 2 or 0.5.`);
    if (kind !== 'COUNT' && !reason.trim()) return setError('Give a short reason.');
    setBusy(true); setError('');
    try {
      const r = await api.adjustStock(item.id, { kind, qtyMilli: kind === 'ADJUST' ? sign * milli : milli, reason: reason.trim() || null }, key.current);
      notify('success', `${item.name}: now ${formatStockQty(r.onHandMilli, r.unit)}.`);
      onDone();
    } catch (e) { key.current = newKey(); setError(e instanceof ApiError ? e.message : messageOf(e)); } finally { setBusy(false); }
  };
  const tabs: Array<[AdjustKind, string]> = [['WASTAGE', 'Wastage'], ['COUNT', 'Physical count'], ['ADJUST', 'Correction']];
  return (
    <Modal title={`Adjust ${item.name}`} onClose={onClose}>
      <p className="mb-3 text-sm text-muted-foreground">In stock now: <span className="font-semibold text-foreground">{formatStockQty(item.onHandMilli, item.unit)}</span></p>
      <div className="mb-4 flex gap-2" role="tablist">
        {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={kind === k} className={`chip ${kind === k ? 'chip-active' : ''}`} onClick={() => { setKind(k); setError(''); }}>{label}</button>)}
      </div>
      <p className="mb-2 text-sm">
        {kind === 'WASTAGE' && 'How much was spoiled, spilled or thrown away?'}
        {kind === 'COUNT' && 'How much is actually on the shelf? Stock is set to this amount.'}
        {kind === 'ADJUST' && 'Fix a mistake, for example a wrong quantity in an earlier entry.'}
      </p>
      <div className="flex gap-2">
        {kind === 'ADJUST' && (
          <div className="flex shrink-0 gap-1.5" role="group" aria-label="Add or remove">
            <button className={`pay-btn h-10 w-10 ${sign === 1 ? 'pay-btn-active' : ''}`} aria-label="Add to stock" onClick={() => setSign(1)}>+</button>
            <button className={`pay-btn h-10 w-10 ${sign === -1 ? 'pay-btn-active' : ''}`} aria-label="Remove from stock" onClick={() => setSign(-1)}>−</button>
          </div>
        )}
        <input className="field min-w-0 flex-1" inputMode="decimal" placeholder={`Quantity in ${u}`} aria-label={`Quantity in ${u}`} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
      </div>
      <input className="field mt-2 w-full" maxLength={200} placeholder={kind === 'COUNT' ? 'Note (optional)' : 'Reason'} aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save'}</button>
    </Modal>
  );
}

function HistoryDialog({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const { api, fail } = useSession();
  const [rows, setRows] = useState<StockMovement[] | null>(null);
  useEffect(() => { api.movements(item.id, 200).then(setRows).catch((e) => { setRows([]); fail(e); }); }, [api, fail, item.id]);
  return (
    <Modal title={`${item.name}: history`} onClose={onClose} width="max-w-2xl">
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr><th className="py-2">When</th><th>What</th><th className="text-right">Change</th><th className="pl-4">Details</th></tr></thead>
          <tbody>
            {rows === null && <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">Loading…</td></tr>}
            {rows?.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">No movements yet.</td></tr>}
            {rows?.map((m) => (
              <tr key={m.id} className="border-t border-border">
                <td className="whitespace-nowrap py-2 pr-3">{when(m.createdAt)}</td>
                <td>{KIND_LABEL[m.kind]}</td>
                <td className={`text-right tabular-nums ${m.deltaMilli < 0 ? 'text-destructive' : 'text-success'}`}>{m.deltaMilli > 0 ? '+' : ''}{formatStockQty(m.deltaMilli, item.unit)}</td>
                <td className="pl-4 text-muted-foreground">{[m.refNo, m.reason, m.userName].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function EditDialog({ item, onClose, onDone }: { item: StockItem; onClose: () => void; onDone: () => void }) {
  const { api } = useSession();
  const key = useRef(newKey());
  const [name, setName] = useState(item.name);
  const [reorder, setReorder] = useState(item.reorderLevelMilli ? formatQty(item.reorderLevelMilli) : '');
  const [error, setError] = useState('');
  const save = async () => {
    const r = reorder.trim() ? parseQty(reorder) : 0;
    if (!name.trim()) return setError('Enter the material name.');
    if (r === null) return setError(`Reorder level is in ${unitLabel(item.unit)}, like 5 or 2.5.`);
    try { await api.updateStockItem(item.id, { name: name.trim(), reorderLevelMilli: r }, key.current); onDone(); } catch (e) { key.current = newKey(); setError(messageOf(e)); }
  };
  return (
    <Modal title={`Edit ${item.name}`} onClose={onClose}>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Name</span><input className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Reorder at ({unitLabel(item.unit)})</span><input className="field" inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} /></label>
      <p className="mt-2 text-xs text-muted-foreground">The unit cannot change once a material exists. Add a new material instead.</p>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full" onClick={() => void save()}>Save</button>
    </Modal>
  );
}
