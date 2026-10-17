import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CookingPot, ImageOff, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Catalog, Item } from '../lib/api.ts';
import { formatPaise, formatRateBp, paiseToInput, parseRupees } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal, PageShell, VegMark } from '../components/ui.tsx';
import { RecipeDialog } from './RecipeDialog.tsx';
import { preparePhoto } from '../lib/photo.ts';
import type { PreparedPhoto } from '../lib/photo.ts';
import { MenuCategories } from './MenuCategories.tsx';
import { MenuImport } from './MenuImport.tsx';
import { MenuPhotos } from './MenuPhotos.tsx';

type Tab = 'items' | 'categories' | 'import' | 'photos';
const TABS: Array<[Tab, string]> = [['items', 'Items'], ['categories', 'Categories'], ['import', 'Bulk upload'], ['photos', 'Bulk photos']];
const TAB_KEY = 'pos.menu.tab';
const readTab = (): Tab => { try { const t = sessionStorage.getItem(TAB_KEY); return t === 'categories' || t === 'import' || t === 'photos' ? t : 'items'; } catch { return 'items'; } };

/** Menu creation: items (with veg / non-veg), categories and bulk upload. Changes appear on the billing screen at once. */
export function MenuItems() {
  const { api, user, fail } = useSession();
  const [tab, setTabState] = useState<Tab>(readTab);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const canEdit = user?.role === 'manager' || user?.role === 'owner';
  const setTab = (t: Tab) => { setTabState(t); try { sessionStorage.setItem(TAB_KEY, t); } catch { /* storage unavailable */ } };
  const load = useCallback(() => api.catalog().then(setCatalog).catch(fail), [api, fail]);
  useEffect(() => { void load(); }, [load]);

  return (
    <PageShell route="menu-items" title="Menu creation" subtitle="Build your menu here. Changes appear on the billing screen straight away.">
      <div className="mb-5 flex gap-2 border-b border-border" role="tablist" aria-label="Menu sections">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {label}
            {t === 'items' && catalog && <span className="ml-1.5 text-xs font-medium opacity-70">{catalog.items.length}</span>}
            {t === 'categories' && catalog && <span className="ml-1.5 text-xs font-medium opacity-70">{catalog.categories.length}</span>}
          </button>
        ))}
      </div>
      {!canEdit && <p className="mb-4 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">You can view the menu. Only a manager or owner can change it.</p>}
      {!catalog ? <p className="text-sm text-muted-foreground">Loading…</p>
        : tab === 'items' ? <ItemsTab catalog={catalog} canEdit={canEdit} reload={load} />
        : tab === 'categories' ? <MenuCategories catalog={catalog} canEdit={canEdit} reload={load} />
        : tab === 'photos' ? <MenuPhotos catalog={catalog} canEdit={canEdit} reload={load} />
        : <MenuImport canEdit={canEdit} reload={load} onDone={() => setTab('items')} />}
    </PageShell>
  );
}

function ItemsTab({ catalog, canEdit, reload }: { catalog: Catalog; canEdit: boolean; reload: () => Promise<void> }) {
  const { api, notify, fail } = useSession();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [type, setType] = useState<'all' | 'veg' | 'nonveg'>('all');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Item | null>(null);
  const [recipeFor, setRecipeFor] = useState<Item | null>(null);
  const [recipeCounts, setRecipeCounts] = useState<Record<string, number>>({});
  const loadRecipes = useCallback(() => { api.recipes().then((r) => setRecipeCounts(Object.fromEntries(r.map((x) => [x.itemId, x.lines])))).catch(() => { /* stock optional */ }); }, [api]);
  useEffect(loadRecipes, [loadRecipes]);

  const catName = (id: string | null) => catalog.categories.find((c) => c.id === id)?.name ?? 'No category';
  const taxName = (id: string) => { const t = catalog.taxGroups.find((g) => g.id === id); return t ? `GST ${formatRateBp(t.rateBp)}` : '—'; };
  const q = query.trim().toLowerCase();
  const shown = catalog.items.filter((i) =>
    (category === 'all' || (category === 'none' ? !i.categoryId : i.categoryId === category))
    && (type === 'all' || (type === 'veg' ? i.isVeg === 1 : i.isVeg === 0))
    && (!q || i.name.toLowerCase().includes(q) || i.barcode === q));

  const remove = async (item: Item) => {
    try { await api.deleteItem(item.id); notify('success', `${item.name} removed from the menu. Past bills keep it.`); await reload(); } catch (e) { fail(e); } finally { setDeleting(null); }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input className="field w-60 pl-9" placeholder="Search items" aria-label="Search items" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="field" aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="none">No category</option>
        </select>
        <div className="flex gap-1.5" role="group" aria-label="Filter by food type">
          {([['all', 'All'], ['veg', 'Veg'], ['nonveg', 'Non-veg']] as const).map(([k, label]) => (
            <button key={k} className={`chip gap-1.5 ${type === k ? 'chip-active' : ''}`} aria-pressed={type === k} onClick={() => setType(k)}>
              {k !== 'all' && <span aria-hidden className="inline-flex"><VegMark veg={k === 'veg'} /></span>}{label}
            </button>
          ))}
        </div>
        {canEdit && <button className="btn-primary ml-auto" onClick={() => setEditing('new')}><Plus className="h-4 w-4" />Add item</button>}
      </div>

      <table className="table">
        <thead className="bg-muted text-left">
          <tr><th className="p-3">Item</th><th>Category</th><th>GST</th><th className="text-right">Price</th><th className="pl-6">Recipe</th><th className="w-24" /></tr>
        </thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">{catalog.items.length === 0 ? 'No items yet. Add one, or use Bulk upload.' : 'No items match.'}</td></tr>}
          {shown.map((i) => (
            <tr key={i.id} className="border-t border-border">
              <td className="p-3">
                <div className="flex items-center gap-3">
                  <ItemThumb item={i} size="h-10 w-10" />
                  <div className="min-w-0">
                <span className="flex items-center gap-2 font-medium"><VegMark veg={i.isVeg} />{i.name}</span>
                {(i.shortName || i.barcode || i.hsnCode) && <span className="mt-0.5 block pl-5 text-xs text-muted-foreground">{[i.shortName && `Short: ${i.shortName}`, i.hsnCode && `HSN ${i.hsnCode}`, i.barcode && `Barcode ${i.barcode}`].filter(Boolean).join(' · ')}</span>}
                  </div>
                </div>
              </td>
              <td className={i.categoryId ? '' : 'text-muted-foreground'}>{catName(i.categoryId)}</td>
              <td>{taxName(i.taxGroupId)}</td>
              <td className="text-right tabular-nums">{formatPaise(i.price)}{i.unit !== 'pcs' && <span className="text-xs text-muted-foreground"> / {i.unit}</span>}</td>
              <td className="pl-6">
                <button className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm hover:bg-secondary" onClick={() => setRecipeFor(i)} aria-label={`Recipe for ${i.name}`}>
                  <CookingPot className="h-4 w-4 text-muted-foreground" />{recipeCounts[i.id] ? `${recipeCounts[i.id]} ingredient${recipeCounts[i.id] === 1 ? '' : 's'}` : <span className="text-muted-foreground">{canEdit ? 'Add' : 'None'}</span>}
                </button>
              </td>
              <td className="pr-2">
                {canEdit && (
                  <div className="flex justify-end gap-1">
                    <button className="rail-btn h-9 w-9" aria-label={`Edit ${i.name}`} title="Edit" onClick={() => setEditing(i)}><Pencil className="h-4 w-4" /></button>
                    <button className="rail-btn h-9 w-9" aria-label={`Delete ${i.name}`} title="Delete" onClick={() => setDeleting(i)}><Trash2 className="h-4 w-4" /></button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && <ItemDialog catalog={catalog} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
      {recipeFor && <RecipeDialog item={recipeFor} canEdit={canEdit} onClose={() => setRecipeFor(null)} onSaved={() => { setRecipeFor(null); loadRecipes(); }} />}
      {deleting && (
        <Modal title="Remove item?" onClose={() => setDeleting(null)}>
          <p className="text-sm text-muted-foreground">{deleting.name} will disappear from the billing screen. Past bills are not changed.</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setDeleting(null)}>Keep</button>
            <button className="btn-primary flex-1 bg-destructive" onClick={() => void remove(deleting)}>Remove</button>
          </div>
        </Modal>
      )}
    </>
  );
}

type FoodType = 'veg' | 'nonveg' | 'na';
const toFood = (v: number | null | undefined): FoodType => (v === 1 ? 'veg' : v === 0 ? 'nonveg' : 'na');
const UNITS = ['pcs', 'plate', 'kg', 'l'];

/** Create or edit one menu item. */
function ItemDialog({ catalog, item, onClose, onSaved }: { catalog: Catalog; item: Item | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const [name, setName] = useState(item?.name ?? '');
  const [categoryId, setCategoryId] = useState(item ? item.categoryId ?? '' : catalog.categories[0]?.id ?? '');
  const [price, setPrice] = useState(item ? paiseToInput(item.price) : '');
  const [taxGroupId, setTaxGroupId] = useState(item?.taxGroupId ?? (catalog.taxGroups.find((t) => t.rateBp === 500) ?? catalog.taxGroups[0])?.id ?? '');
  const [food, setFood] = useState<FoodType>(item ? toFood(item.isVeg) : 'veg');
  const [unit, setUnit] = useState(item?.unit ?? 'pcs');
  const [shortName, setShortName] = useState(item?.shortName ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [hsn, setHsn] = useState(item?.hsnCode ?? '');
  const [barcode, setBarcode] = useState(item?.barcode ?? '');
  const [more, setMore] = useState(!!(item?.shortName || item?.hsnCode || item?.barcode));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // undefined = unchanged, null = remove, otherwise a new prepared photo
  const [photo, setPhoto] = useState<PreparedPhoto | null | undefined>(undefined);
  const photoKey = useRef(newKey());

  const save = async () => {
    const paise = parseRupees(price);
    if (!name.trim()) return setError('Enter the item name.');
    if (paise === null || paise <= 0) return setError('Enter the price in rupees, like 129 or 49.50.');
    if (!taxGroupId) return setError('Choose the GST rate.');
    if (hsn.trim() && !/^\d{4,8}$/.test(hsn.trim())) return setError('HSN must be 4 to 8 digits.');
    setBusy(true); setError('');
    const input = {
      name: name.trim(), categoryId: categoryId || null, price: paise, taxGroupId, unit,
      isVeg: food === 'na' ? null : food === 'veg', shortName: shortName.trim() || null, hsnCode: hsn.trim() || null, barcode: barcode.trim() || null,
      description: description.trim() || null,
    };
    try {
      const id = item ? (await api.updateItem(item.id, input, key.current), item.id) : (await api.createItem(input, key.current)).id;
      try {
        if (photo) await api.setItemImage(id, photo.dataBase64, photoKey.current);
        else if (photo === null && item?.imageFile) await api.removeItemImage(id, photoKey.current);
      } catch (e) {
        // the item itself is saved; only the photo failed
        notify('error', `${input.name} was saved, but the photo was not: ${messageOf(e)}`);
        await onSaved();
        return;
      }
      notify('success', item ? `${input.name} updated.` : `${input.name} added. It is on the billing screen now.`);
      await onSaved();
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };

  const foodBtn = (k: FoodType, label: string) => (
    <button type="button" role="radio" aria-checked={food === k} onClick={() => setFood(k)}
      className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition-colors ${food === k
        ? k === 'veg' ? 'border-veg bg-veg/10 text-veg' : k === 'nonveg' ? 'border-nonveg bg-nonveg/10 text-nonveg' : 'border-primary bg-accent text-primary'
        : 'border-border bg-background text-muted-foreground hover:border-primary'}`}>
      {k !== 'na' && <span aria-hidden className="inline-flex"><VegMark veg={k === 'veg'} /></span>}{label}
    </button>
  );

  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add item'} onClose={onClose} width="max-w-lg">
      <div className="space-y-3">
        <PhotoPicker name={name} current={item?.imageFile ?? null} value={photo} onChange={(p) => { setPhoto(p); photoKey.current = newKey(); }} />
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Item name</span>
          <input className="field" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Description <span className="font-normal text-muted-foreground">(optional, shown on the online menu)</span></span>
          <textarea className="field min-h-16 py-2" maxLength={300} rows={2} placeholder="e.g. Crispy dosa with potato masala, chutney and sambar" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div>
          <span className="mb-1 block text-sm font-medium">Food type</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Food type">
            {foodBtn('veg', 'Veg')}{foodBtn('nonveg', 'Non-veg')}{foodBtn('na', 'Not food')}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Shown with the green or red mark on the billing screen. Choose Not food for water, packaging and similar.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Category</span>
            <select className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">No category</option>
              {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Price ₹ (GST included)</span>
            <input className="field" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">GST rate</span>
            <select className="field" value={taxGroupId} onChange={(e) => setTaxGroupId(e.target.value)}>
              {catalog.taxGroups.map((t) => <option key={t.id} value={t.id}>GST {formatRateBp(t.rateBp)}{t.priceIncludesTax ? ' (incl.)' : ''}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Sold per</span>
            <select className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {[...new Set([...UNITS, unit])].map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </label>
        </div>
        {!more ? <button type="button" className="text-sm font-semibold text-primary" onClick={() => setMore(true)}>More details (short name, HSN, barcode)</button> : (
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Short name</span><input className="field" maxLength={40} placeholder="For quick search" value={shortName} onChange={(e) => setShortName(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">HSN</span><input className="field" inputMode="numeric" maxLength={8} placeholder="Optional" value={hsn} onChange={(e) => setHsn(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Barcode</span><input className="field" maxLength={40} placeholder="Optional" value={barcode} onChange={(e) => setBarcode(e.target.value)} /></label>
          </div>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mt-5 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : item ? 'Save changes' : 'Add item'}</button>
      </div>
    </Modal>
  );
}

/** Small square photo, or the first letter when there is none. */
export function ItemThumb({ item, size }: { item: Pick<Item, 'name' | 'imageFile'>; size: string }) {
  const { api } = useSession();
  const [broken, setBroken] = useState(false);
  if (item.imageFile && !broken) {
    return <img src={api.imageUrl(item.imageFile)} alt="" loading="lazy" onError={() => setBroken(true)} className={`${size} shrink-0 rounded-lg bg-muted object-cover`} />;
  }
  return <span aria-hidden className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-muted font-display text-muted-foreground`}>{item.name.charAt(0)}</span>;
}

function PhotoPicker({ name, current, value, onChange }: { name: string; current: string | null; value: PreparedPhoto | null | undefined; onChange: (p: PreparedPhoto | null | undefined) => void }) {
  const { api } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [over, setOver] = useState(false);
  const shown = value ? value.previewUrl : value === null ? null : current ? api.imageUrl(current) : null;
  useEffect(() => () => { if (value) URL.revokeObjectURL(value.previewUrl); }, [value]);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(''); setWorking(true);
    try { onChange(await preparePhoto(file)); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  };

  return (
    <div className="flex items-center gap-4">
      <button type="button" aria-label={shown ? 'Change photo' : 'Add photo'} onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files[0]); }}
        className={`relative flex h-24 w-32 shrink-0 items-center justify-center overflow-hidden rounded-xl border-2 border-dashed bg-muted text-muted-foreground transition-colors ${over ? 'border-primary' : 'border-border hover:border-primary'}`}>
        {shown ? <img src={shown} alt={`Photo of ${name || 'item'}`} className="h-full w-full object-cover" /> : <Camera className="h-7 w-7" />}
        {working && <span className="absolute inset-0 flex items-center justify-center bg-card/70 text-xs font-semibold">Preparing…</span>}
      </button>
      <div className="min-w-0 text-sm">
        <p className="font-medium">Photo <span className="font-normal text-muted-foreground">(optional)</span></p>
        <p className="text-xs text-muted-foreground">JPG, PNG or WebP. Drop a file here or choose one. It is resized for the menu.</p>
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={working} onClick={() => input.current?.click()}><Camera className="h-3.5 w-3.5" />{shown ? 'Change' : 'Choose photo'}</button>
          {shown && <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={() => onChange(current ? null : undefined)}><ImageOff className="h-3.5 w-3.5" />Remove</button>}
        </div>
        {value && <p className="mt-1 text-xs text-muted-foreground">New photo, {Math.max(1, Math.round(value.bytes / 1024))} KB. Saved when you save the item.</p>}
        {value === null && <p className="mt-1 text-xs text-muted-foreground">The photo will be removed when you save.</p>}
        {error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Photo file"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void take(f); }} />
    </div>
  );
}
