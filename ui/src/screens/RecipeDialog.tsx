import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Item, RecipeLine, StockItem } from '../lib/api.ts';
import { formatQty, parseQty, unitLabel } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';

interface RecipeRow { key: number; stockItemId: string; qty: string }

/** Ingredients used by ONE of this item. Each bill deducts them from stock. */
export function RecipeDialog({ item, canEdit, onClose, onSaved }: { item: Item; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const { api, fail, notify } = useSession();
  const key = useRef(newKey());
  const seq = useRef(1);
  const [materials, setMaterials] = useState<StockItem[] | null>(null);
  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([api.stockItems(), api.recipe(item.id)]).then(([m, r]: [StockItem[], RecipeLine[]]) => {
      setMaterials(m);
      setRows(r.map((l) => ({ key: seq.current++, stockItemId: l.stockItemId, qty: formatQty(l.qtyMilli) })));
    }).catch((e) => { setMaterials([]); fail(e); });
  }, [api, fail, item.id]);
  const unitOf = (id: string) => unitLabel(materials?.find((m) => m.id === id)?.unit ?? '');
  const save = async () => {
    const lines: Array<{ stockItemId: string; qtyMilli: number }> = [];
    for (const r of rows) {
      const q = parseQty(r.qty);
      if (!r.stockItemId || q === null || q === 0) return setError('Each ingredient needs a material and a quantity, like 0.12 or 1.');
      lines.push({ stockItemId: r.stockItemId, qtyMilli: q });
    }
    setBusy(true); setError('');
    try { await api.setRecipe(item.id, lines, key.current); notify('success', `Recipe for ${item.name} saved. Bills now use up its ingredients.`); onSaved(); }
    catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Recipe: ${item.name}`} onClose={onClose} width="max-w-lg">
      <p className="mb-3 text-sm text-muted-foreground">How much of each material one {item.name} uses. Every bill takes this from stock. Leave it empty if you do not track this item.</p>
      {materials === null ? <p className="text-sm text-muted-foreground">Loading…</p> : materials.length === 0 ? (
        <p className="text-sm text-muted-foreground">No materials yet. Add them on the Stock screen first.</p>
      ) : (
        <div className="space-y-2">
          {rows.length === 0 && <p className="text-sm text-muted-foreground">No ingredients.</p>}
          {rows.map((r, i) => (
            <div key={r.key} className="flex items-center gap-2">
              <select className="field min-w-0 flex-1" aria-label={`Ingredient ${i + 1}`} disabled={!canEdit} value={r.stockItemId} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, stockItemId: e.target.value } : x)))}>
                <option value="">Select material</option>
                {materials.map((m) => <option key={m.id} value={m.id} disabled={m.id !== r.stockItemId && rows.some((x) => x.stockItemId === m.id)}>{m.name}</option>)}
              </select>
              <input className="field w-28" inputMode="decimal" aria-label={`Ingredient ${i + 1} quantity`} placeholder="Qty" disabled={!canEdit} value={r.qty} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, qty: e.target.value } : x)))} />
              <span className="w-10 text-sm text-muted-foreground">{unitOf(r.stockItemId)}</span>
              {canEdit && <button className="rail-btn h-9 w-9" aria-label={`Remove ingredient ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" /></button>}
            </div>
          ))}
          {canEdit && <button className="btn-ghost" onClick={() => setRows((rs) => [...rs, { key: seq.current++, stockItemId: '', qty: '' }])}><Plus className="h-4 w-4" />Add ingredient</button>}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {canEdit && materials && materials.length > 0 && <button className="btn-primary mt-5 w-full" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save recipe'}</button>}
    </Modal>
  );
}
