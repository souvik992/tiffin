import { useRef, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Catalog, ModifierGroup } from '../lib/api.ts';
import { formatPrice, paiseToInput, parseRupees } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';

/** Menu creation > Add-on groups: choices offered when an item is added to a bill (Extras, Size, Spice level). */
export function MenuAddons({ catalog, canEdit, reload }: { catalog: Catalog; canEdit: boolean; reload: () => Promise<unknown> }) {
  const { api, notify, fail } = useSession();
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ModifierGroup | null>(null);
  const usedBy = (g: ModifierGroup) => catalog.items.filter((i) => i.modifierGroupIds.includes(g.id)).length;
  const remove = async (g: ModifierGroup) => {
    try { await api.deleteModifierGroup(g.id, newKey()); notify('success', `${g.name} removed.`); setDeleting(null); await reload(); } catch (e) { fail(e); }
  };
  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <p className="text-sm text-muted-foreground">Choices offered when an item is added to a bill, like Extras, Size or Spice level. Attach a group to items in the item editor.</p>
        {canEdit && <button className="btn-primary ml-auto shrink-0" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />New group</button>}
      </div>
      {catalog.modifierGroups.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No add-on groups yet.</p> : (
        <table className="table">
          <thead className="bg-muted text-left"><tr><th className="p-3">Group</th><th className="p-3">Options</th><th className="p-3">Customer chooses</th><th className="p-3 text-right">Items</th><th className="w-28" /></tr></thead>
          <tbody>
            {catalog.modifierGroups.map((g) => (
              <tr key={g.id} className="border-t border-border">
                <td className="p-3 font-semibold">{g.name}</td>
                <td className="p-3 text-sm">{g.modifiers.map((m) => `${m.name}${m.price ? ` +${formatPrice(m.price)}` : ''}`).join(', ')}</td>
                <td className="p-3 text-sm text-muted-foreground">{chooseText(g.minSelect, g.maxSelect)}</td>
                <td className="p-3 text-right tabular-nums">{usedBy(g)}</td>
                <td className="p-3 text-right">{canEdit && <span className="inline-flex gap-1">
                  <button className="btn-ghost h-9 px-3" onClick={() => setEditing(g)} aria-label={`Edit ${g.name}`}><Pencil className="h-4 w-4" /></button>
                  <button className="btn-ghost h-9 px-3 text-destructive" onClick={() => setDeleting(g)} aria-label={`Remove ${g.name}`}><Trash2 className="h-4 w-4" /></button>
                </span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <GroupDialog group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
      {deleting && (
        <Modal title="Remove add-on group?" onClose={() => setDeleting(null)}>
          <p className="text-sm text-muted-foreground">{deleting.name} is taken off {usedBy(deleting)} item(s). Past bills and open bills keep their add-ons.</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setDeleting(null)}>Keep</button>
            <button className="btn-primary flex-1 bg-destructive" onClick={() => void remove(deleting)}>Remove</button>
          </div>
        </Modal>
      )}
    </>
  );
}

const chooseText = (min: number, max: number) => (min === 0 ? (max === 1 ? 'Optional, one' : `Optional, up to ${max}`) : min === max ? `Exactly ${min}` : `${min} to ${max}`);

interface Row { key: number; id?: string; name: string; price: string }

function GroupDialog({ group, onClose, onSaved }: { group: ModifierGroup | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const next = useRef(1);
  const [name, setName] = useState(group?.name ?? '');
  const [min, setMin] = useState(String(group?.minSelect ?? 0));
  const [max, setMax] = useState(String(group?.maxSelect ?? 1));
  const [rows, setRows] = useState<Row[]>(group ? group.modifiers.map((m) => ({ key: next.current++, id: m.id, name: m.name, price: m.price ? paiseToInput(m.price) : '' })) : [{ key: next.current++, name: '', price: '' }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  const save = async () => {
    const filled = rows.filter((r) => r.name.trim());
    if (!name.trim()) return setError('Name the group, for example "Extras".');
    if (filled.length === 0) return setError('Add at least one option.');
    const prices = filled.map((r) => (r.price.trim() ? parseRupees(r.price) : 0));
    if (prices.some((p) => p === null)) return setError('Prices are in rupees, like 20 or 15.50 (empty = free).');
    const minN = Number(min), maxN = Number(max);
    if (!Number.isInteger(minN) || !Number.isInteger(maxN) || minN < 0 || maxN < 1 || minN > maxN) return setError('"At least" must be 0 or more and not more than "at most" (1 or more).');
    if (minN > filled.length) return setError('"At least" is more than the number of options.');
    setBusy(true); setError('');
    const input = { name: name.trim(), minSelect: minN, maxSelect: Math.min(maxN, filled.length), modifiers: filled.map((r, i) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.trim(), price: prices[i]! })) };
    try {
      if (group) await api.updateModifierGroup(group.id, input, key.current); else await api.createModifierGroup(input, key.current);
      notify('success', `${input.name} saved.`);
      await onSaved();
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={group ? `Edit ${group.name}` : 'New add-on group'} onClose={onClose} width="max-w-lg">
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Group name</span>
        <input className="field" maxLength={60} placeholder="Extras, Size, Spice level…" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1"><span className="font-medium">Customer chooses at least</span><input className="field" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} aria-label="At least" /><span className="text-xs text-muted-foreground">0 = optional</span></label>
        <label className="flex flex-col gap-1"><span className="font-medium">and at most</span><input className="field" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} aria-label="At most" /></label>
      </div>
      <p className="mt-4 text-sm font-medium">Options</p>
      <ul className="mt-1 space-y-2">
        {rows.map((r) => (
          <li key={r.key} className="flex gap-2">
            <input className="field min-w-0 flex-1" maxLength={60} placeholder="Extra cheese" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} aria-label="Option name" />
            <input className="field w-28" inputMode="decimal" placeholder="₹ price" value={r.price} onChange={(e) => set(r.key, { price: e.target.value })} aria-label="Option price" />
            <button className="btn-ghost h-11 w-11 shrink-0 px-0 text-destructive" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label="Remove option" disabled={rows.length === 1}><Trash2 className="h-4 w-4" /></button>
          </li>
        ))}
      </ul>
      <button className="btn-ghost mt-2" onClick={() => setRows((rs) => [...rs, { key: next.current++, name: '', price: '' }])}><Plus className="h-4 w-4" />Add option</button>
      {group && <p className="mt-2 text-xs text-muted-foreground">Changed prices apply to new bills. Bills already made keep their prices.</p>}
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </Modal>
  );
}
