import { useEffect, useMemo, useRef, useState } from 'react';
import { ChefHat, Pencil, Plus, Printer as PrinterIcon, Search, Trash2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Catalog, PrepStation } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';

/**
 * Menu > Prep stations: where in the kitchen things are made (Tandoor, Chinese, Bar...). Kitchen tickets (KOT) are split
 * by station. A station gets whole categories, and single items (an item's own station wins over its category's).
 * Which printer prints which station is set in Settings > Printer setup.
 */
export function MenuStations({ catalog, canEdit, reload }: { catalog: Catalog; canEdit: boolean; reload: () => Promise<void> }) {
  const { api, notify, fail } = useSession();
  const [stations, setStations] = useState<PrepStation[] | null>(null);
  const [editing, setEditing] = useState<PrepStation | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PrepStation | null>(null);
  const load = () => api.prepStations().then(setStations).catch((e) => { setStations([]); fail(e); });
  useEffect(() => { void load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  const unmapped = catalog.items.filter((i) => !i.prepStationId && !catalog.categories.find((c) => c.id === i.categoryId)?.prepStationId).length;

  const remove = async (s: PrepStation) => {
    try { await api.deletePrepStation(s.id); notify('success', `${s.name} removed. Its items print on printers set to All stations.`); await load(); await reload(); } catch (e) { fail(e); } finally { setDeleting(null); }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">Kitchen tickets (KOT) are split by prep station: each station gets only its own items. Give a station whole categories, or single items. Choose which printer prints which station in Settings, Printer setup.</p>
        {canEdit && <button className="btn-primary ml-auto" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add prep station</button>}
      </div>
      {unmapped > 0 && <p className="mb-3 rounded-lg bg-accent/60 p-2 text-xs">{unmapped} item{unmapped === 1 ? ' has' : 's have'} no prep station: {unmapped === 1 ? 'it prints' : 'they print'} only on printers set to All stations.</p>}
      <table className="table">
        <thead className="bg-muted text-left"><tr><th className="p-3">Prep station</th><th>Categories</th><th className="text-right">Items made here</th><th>Printed on</th><th className="w-24" /></tr></thead>
        <tbody>
          {stations === null && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
          {stations?.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No prep stations yet. Add one, like Kitchen, Tandoor or Bar.</td></tr>}
          {stations?.map((s) => (
            <tr key={s.id} className="border-t border-border align-top">
              <td className="p-3 font-medium"><span className="inline-flex items-center gap-2"><ChefHat className="h-4 w-4 text-primary" />{s.name}</span></td>
              <td className="py-3 text-sm">{s.categoryIds.map((id) => catalog.categories.find((c) => c.id === id)?.name).filter(Boolean).join(', ') || <span className="text-muted-foreground">None</span>}
                {s.itemIds.length > 0 && <span className="block text-xs text-muted-foreground">+ {s.itemIds.length} single item{s.itemIds.length === 1 ? '' : 's'}</span>}</td>
              <td className="py-3 text-right tabular-nums">{s.itemCount}</td>
              <td className="py-3 text-sm">{s.printers.length ? s.printers.map((p) => p.name).join(', ') : <span className="text-destructive">No printer yet</span>}</td>
              <td className="pr-2 pt-2">
                {canEdit && (
                  <div className="flex justify-end gap-1">
                    <button className="rail-btn h-9 w-9" aria-label={`Edit ${s.name}`} title="Edit" onClick={() => setEditing(s)}><Pencil className="h-4 w-4" /></button>
                    <button className="rail-btn h-9 w-9" aria-label={`Remove ${s.name}`} title="Remove" onClick={() => setDeleting(s)}><Trash2 className="h-4 w-4" /></button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground"><PrinterIcon className="h-3.5 w-3.5" />Printers: Settings, Printer setup, edit a printer, Kitchen tickets (KOT) for.</p>

      {editing && <StationDialog station={editing === 'new' ? null : editing} catalog={catalog} stations={stations ?? []} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); await reload(); }} />}
      {deleting && (
        <Modal title={`Remove ${deleting.name}?`} onClose={() => setDeleting(null)}>
          <p className="text-sm text-muted-foreground">Its categories and items will have no prep station, and printers stop printing it. Bills are not affected.</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setDeleting(null)}>Keep</button>
            <button className="btn-primary flex-1 bg-destructive" onClick={() => void remove(deleting)}>Remove</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function StationDialog({ station, catalog, stations, onClose, onSaved }: { station: PrepStation | null; catalog: Catalog; stations: PrepStation[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [name, setName] = useState(station?.name ?? '');
  const [cats, setCats] = useState<string[]>(station?.categoryIds ?? []);
  const [items, setItems] = useState<string[]>(station?.itemIds ?? []);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const otherStation = (id: string | null) => (id && id !== station?.id ? stations.find((s) => s.id === id)?.name ?? null : null);
  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t.length < 2 ? [] : catalog.items.filter((i) => i.name.toLowerCase().includes(t) && !items.includes(i.id)).slice(0, 8);
  }, [q, catalog.items, items]);

  const save = async () => {
    if (!name.trim()) return setError('Give the prep station a name, like Tandoor.');
    setBusy(true); setError('');
    try {
      const id = station?.id ?? (await api.createPrepStation(name.trim(), key.current)).id;
      await api.updatePrepStation(id, { name: name.trim(), categoryIds: cats, itemIds: items }, newKey());
      notify('success', station ? `${name.trim()} saved.` : `${name.trim()} added. Choose its printer in Settings, Printer setup.`);
      await onSaved();
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={station ? `Edit ${station.name}` : 'Add prep station'} onClose={onClose} width="max-w-xl">
      <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Name</span>
        <input className="field" maxLength={30} placeholder="For example Tandoor, Chinese or Bar" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <div className="mt-4 text-sm">
        <p className="font-medium">Categories made here</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {catalog.categories.map((c) => {
            const on = cats.includes(c.id), other = otherStation(c.prepStationId);
            return (
              <button key={c.id} type="button" aria-pressed={on} className={`chip ${on ? 'chip-active' : ''}`} onClick={() => setCats(on ? cats.filter((x) => x !== c.id) : [...cats, c.id])} title={other && !on ? `Now at ${other}: choosing it moves it here` : undefined}>
                {c.name}{other && !on ? <span className="ml-1 text-[10px] opacity-60">({other})</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-4 text-sm">
        <p className="font-medium">Single items made here</p>
        <p className="text-xs text-muted-foreground">An item's own station wins over its category's, for example Paneer Tikka at the Tandoor while Starters are at the Kitchen.</p>
        <div className="relative mt-2">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input className="field w-full pl-9" placeholder="Search an item to add" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search an item to add" />
        </div>
        {found.length > 0 && (
          <ul className="mt-1 max-h-48 overflow-auto rounded-lg border border-border">
            {found.map((i) => (
              <li key={i.id}><button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted" onClick={() => { setItems([...items, i.id]); setQ(''); }}>
                <span>{i.name}</span><span className="text-xs text-muted-foreground">{otherStation(i.prepStationId) ? `now at ${otherStation(i.prepStationId)}` : catalog.categories.find((c) => c.id === i.categoryId)?.name ?? ''}</span>
              </button></li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          {items.map((id) => <span key={id} className="chip chip-active">{catalog.items.find((i) => i.id === id)?.name ?? 'Removed item'}<button type="button" className="ml-1" aria-label="Remove" onClick={() => setItems(items.filter((x) => x !== id))}>×</button></span>)}
          {items.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mt-5 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : station ? 'Save' : 'Add prep station'}</button>
      </div>
    </Modal>
  );
}
