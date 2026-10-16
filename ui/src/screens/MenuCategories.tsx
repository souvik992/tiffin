import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Catalog, Category } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';

/** Categories: the tabs on the billing screen, in this order. The kitchen station decides which printer gets the KOT. */
export function MenuCategories({ catalog, canEdit, reload }: { catalog: Catalog; canEdit: boolean; reload: () => Promise<void> }) {
  const { api, notify, fail } = useSession();
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [moving, setMoving] = useState(false);
  const [stations, setStations] = useState<string[]>([]);
  useEffect(() => {
    api.printers().then((ps) => setStations([...new Set([...ps.flatMap((p) => p.stations), ...catalog.categories.map((c) => c.kitchenStation).filter((s): s is string => !!s)])].sort()))
      .catch(() => setStations([...new Set(catalog.categories.map((c) => c.kitchenStation).filter((s): s is string => !!s))]));
  }, [api, catalog.categories]);

  const cats = catalog.categories;
  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= cats.length || moving) return;
    const ids = cats.map((c) => c.id);
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    setMoving(true);
    try { await api.reorderCategories(ids); await reload(); } catch (e) { fail(e); } finally { setMoving(false); }
  };
  const remove = async (c: Category) => {
    try { await api.deleteCategory(c.id); notify('success', `${c.name} deleted.`); await reload(); } catch (e) { fail(e); } finally { setDeleting(null); }
  };

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <p className="text-sm text-muted-foreground">Categories appear as tabs on the billing screen, in this order.</p>
        {canEdit && <button className="btn-primary ml-auto" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add category</button>}
      </div>
      <table className="table">
        <thead className="bg-muted text-left">
          <tr>{canEdit && <th className="w-24 p-3">Order</th>}<th className={canEdit ? '' : 'p-3'}>Category</th><th>Kitchen station</th><th className="text-right">Items</th><th className="w-24" /></tr>
        </thead>
        <tbody>
          {cats.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No categories yet.</td></tr>}
          {cats.map((c, i) => (
            <tr key={c.id} className="border-t border-border">
              {canEdit && (
                <td className="p-2">
                  <div className="flex gap-1">
                    <button className="rail-btn h-8 w-8" aria-label={`Move ${c.name} up`} disabled={i === 0 || moving} onClick={() => void move(i, -1)}><ArrowUp className="h-4 w-4" /></button>
                    <button className="rail-btn h-8 w-8" aria-label={`Move ${c.name} down`} disabled={i === cats.length - 1 || moving} onClick={() => void move(i, 1)}><ArrowDown className="h-4 w-4" /></button>
                  </div>
                </td>
              )}
              <td className={`font-medium ${canEdit ? '' : 'p-3'}`}>{c.name}</td>
              <td className={c.kitchenStation ? '' : 'text-muted-foreground'}>{c.kitchenStation ?? 'None'}</td>
              <td className="text-right tabular-nums">{c.itemCount}</td>
              <td className="pr-2">
                {canEdit && (
                  <div className="flex justify-end gap-1">
                    <button className="rail-btn h-9 w-9" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></button>
                    <button className="rail-btn h-9 w-9" aria-label={`Delete ${c.name}`} title={c.itemCount > 0 ? 'Move or remove its items first' : 'Delete'} disabled={c.itemCount > 0} onClick={() => setDeleting(c)}><Trash2 className="h-4 w-4" /></button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && <CategoryDialog category={editing === 'new' ? null : editing} stations={stations} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
      {deleting && (
        <Modal title="Delete category?" onClose={() => setDeleting(null)}>
          <p className="text-sm text-muted-foreground">{deleting.name} has no items and will be removed from the billing screen.</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setDeleting(null)}>Keep</button>
            <button className="btn-primary flex-1 bg-destructive" onClick={() => void remove(deleting)}>Delete</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function CategoryDialog({ category, stations, onClose, onSaved }: { category: Category | null; stations: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [name, setName] = useState(category?.name ?? '');
  const [station, setStation] = useState(category?.kitchenStation ?? stations[0] ?? 'kitchen');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return setError('Enter the category name.');
    setBusy(true); setError('');
    const input = { name: name.trim(), kitchenStation: station.trim() || null };
    try {
      if (category) await api.updateCategory(category.id, input, key.current); else await api.createCategory(input, key.current);
      notify('success', category ? `${input.name} updated.` : `${input.name} added.`);
      await onSaved();
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={category ? `Edit ${category.name}` : 'Add category'} onClose={onClose}>
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Name</span>
        <input className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} autoFocus />
      </label>
      <label className="mt-3 flex flex-col gap-1 text-sm"><span className="font-medium">Kitchen station</span>
        <input className="field" list="kitchen-stations" maxLength={30} placeholder="For example kitchen or bar" value={station} onChange={(e) => setStation(e.target.value)} />
        <datalist id="kitchen-stations">{stations.map((s) => <option key={s} value={s} />)}</datalist>
        <span className="text-xs text-muted-foreground">Items in this category print a kitchen ticket (KOT) on printers set to this station. If left empty, only printers set to all stations print them.</span>
      </label>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mt-5 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : category ? 'Save changes' : 'Add category'}</button>
      </div>
    </Modal>
  );
}
