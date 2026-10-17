import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, X } from 'lucide-react';
import { BASE, host } from './host.ts';
import { ChannelBadge } from './channels.tsx';

const { useSession, Modal, newKey, messageOf, money } = host;

export type SyncChannel = 'app' | 'website' | 'swiggy' | 'zomato';
interface ChannelSync { mode: 'all' | 'exclude' | 'include'; items: string[]; pricing: 'same' | 'custom'; markupBp: number; prices: Record<string, number> }
interface SyncState { channels: Record<SyncChannel, ChannelSync>; publishedAt: number | null; hub: boolean }
interface CatalogItem { id: string; name: string; price: number; categoryId: string | null; imageFile: string | null; description: string | null; isVeg: number | null }
interface Catalog { items: CatalogItem[]; categories: Array<{ id: string; name: string }> }

const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const LATER: Partial<Record<SyncChannel, string>> = { swiggy: 'Saved now; used when the Swiggy connection is set up.', zomato: 'Saved now; used when the Zomato connection is set up.' };

/** Settings > Online orders > a channel's ⚙: which items it lists (all / all except / only), and its prices. */
export function MenuSyncDialog({ channel, readOnly, onClose }: { channel: SyncChannel; readOnly: boolean; onClose: () => void }) {
  const { api, notify } = useSession();
  const [state, setState] = useState<SyncState | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [mode, setMode] = useState<ChannelSync['mode']>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [pricing, setPricing] = useState<ChannelSync['pricing']>('same');
  const [markup, setMarkup] = useState('');
  const [own, setOwn] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<'save' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());

  useEffect(() => {
    Promise.all([api.request<SyncState>('GET', `${BASE}/menu-sync`), (api as unknown as { catalog(): Promise<Catalog> }).catalog()]).then(([s, c]) => {
      const ch = s.channels[channel];
      setState(s); setCatalog(c);
      setMode(ch.mode); setChosen(new Set(ch.items)); setPricing(ch.pricing);
      setMarkup(ch.markupBp ? String(ch.markupBp / 100) : '');
      setOwn(Object.fromEntries(Object.entries(ch.prices).map(([id, p]) => [id, money.paiseToInput(p)])));
    }).catch((e) => setError(messageOf(e)));
  }, [api, channel]);

  const items = useMemo(() => [...(catalog?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [catalog]);
  const catName = (id: string | null) => catalog?.categories.find((c) => c.id === id)?.name ?? '';
  const listed = (id: string) => mode === 'all' || (mode === 'include' ? chosen.has(id) : !chosen.has(id));
  const shown = items.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()) || catName(i.categoryId).toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const input = () => {
    const bp = markup.trim() ? Math.round(Number(markup) * 100) : 0; // percentage typed by the owner, e.g. 15 or 12.5 (not money)
    if (!Number.isFinite(bp)) throw new Error('Enter the price change as a percentage, like 15.');
    const prices: Record<string, number> = {};
    for (const [id, v] of Object.entries(own)) {
      if (!v.trim()) continue;
      const p = money.parseRupees(v);
      if (p === null) throw new Error(`The price for ${items.find((i) => i.id === id)?.name ?? 'an item'} is not an amount in rupees.`);
      prices[id] = p;
    }
    return { channel, mode, items: mode === 'all' ? [] : [...chosen], pricing, markupBp: pricing === 'custom' ? bp : 0, prices: pricing === 'custom' ? prices : {} };
  };
  const save = async (thenSync: boolean) => {
    setError(null);
    let body: ReturnType<typeof input>;
    try { body = input(); } catch (e) { setError((e as Error).message); return; }
    setBusy(thenSync ? 'sync' : 'save');
    try {
      const s = await api.request<SyncState>('PUT', `${BASE}/menu-sync`, body, key.current);
      key.current = newKey();
      setState(s);
      if (thenSync && s.hub) {
        const r = await api.request<{ publishedAt: number }>('POST', `${BASE}/menu-sync/now`, {}, newKey());
        setState({ ...s, publishedAt: r.publishedAt });
        notify('success', 'Menu sent to the order hub.');
      } else notify('success', 'Menu sync saved. It goes to the order hub within a minute.');
      if (!thenSync) onClose();
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(null); }
  };

  const count = items.filter((i) => listed(i.id)).length;
  return (
    <Modal title="Menu sync" onClose={onClose} width="max-w-3xl">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <ChannelBadge channel={channel} size="md" />
        <span className="text-muted-foreground">{catalog ? `${count} of ${items.length} items listed` : 'Loading…'}</span>
        {state?.publishedAt ? <span className="ml-auto text-xs text-muted-foreground">Last sent to the hub {when(state.publishedAt)}</span> : null}
      </div>
      {LATER[channel] && <p className="mb-3 rounded-lg bg-accent/60 p-2 text-xs">{LATER[channel]}</p>}

      <div className="mb-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Which items">
        {([['all', 'All items', 'The whole menu'], ['exclude', 'All except…', 'Pick items to leave out'], ['include', 'Only…', 'Pick the items to list']] as const).map(([m, label, hint]) => (
          <label key={m} className={`flex cursor-pointer flex-col rounded-xl border p-3 text-sm ${mode === m ? 'border-primary bg-accent' : 'border-border'}`}>
            <span className="flex items-center gap-2 font-semibold"><input type="radio" name="mode" disabled={readOnly} checked={mode === m} onChange={() => setMode(m)} />{label}</span>
            <span className="pl-5 text-xs text-muted-foreground">{hint}</span>
          </label>
        ))}
      </div>

      <div className="mb-3 rounded-xl border border-border p-3">
        <p className="mb-2 text-sm font-semibold">Prices on this channel</p>
        <div className="flex flex-wrap items-center gap-4 text-sm" role="radiogroup" aria-label="Prices">
          <label className="flex items-center gap-2"><input type="radio" name="pricing" disabled={readOnly} checked={pricing === 'same'} onChange={() => setPricing('same')} />Same as the POS</label>
          <label className="flex items-center gap-2"><input type="radio" name="pricing" disabled={readOnly} checked={pricing === 'custom'} onChange={() => setPricing('custom')} />Different prices</label>
          {pricing === 'custom' && (
            <label className="flex items-center gap-2">Change all by
              <input className="field h-9 w-20" inputMode="decimal" disabled={readOnly} placeholder="0" value={markup} onChange={(e) => setMarkup(e.target.value)} aria-label="Price change in percent" />% <span className="text-xs text-muted-foreground">(rounded to ₹1; type a price below to set one item)</span>
            </label>
          )}
        </div>
        {pricing === 'custom' && <p className="mt-2 text-xs text-muted-foreground">Online bills for this channel use these prices, so the bill matches what the customer pays. Your CA should confirm this for GST.</p>}
      </div>

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input className="field w-full pl-9" placeholder="Search items or categories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" />
        {q && <button className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground" onClick={() => setQ('')} aria-label="Clear search"><X className="h-4 w-4" /></button>}
      </div>
      <div className="max-h-[30vh] overflow-y-auto rounded-xl border border-border">
        {!catalog && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        {shown.map((i) => {
          const on = listed(i.id);
          return (
            <div key={i.id} className={`flex items-center gap-3 border-b border-border p-2 last:border-0 ${on ? '' : 'opacity-50'}`}>
              <input type="checkbox" className="h-4 w-4" disabled={readOnly || mode === 'all'} checked={on} onChange={() => toggle(i.id)} aria-label={`List ${i.name}`} />
              {i.imageFile ? <img src={api.imageUrl(i.imageFile)} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" /> : <span className="h-11 w-11 shrink-0 rounded-lg bg-muted" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.name}<span className="ml-2 text-xs font-normal text-muted-foreground">{catName(i.categoryId)}</span></p>
                <p className="truncate text-xs text-muted-foreground">{i.description || 'No description (add one in Menu creation)'}</p>
              </div>
              <span className="shrink-0 text-sm tabular-nums">{money.formatPaise(i.price)}</span>
              {pricing === 'custom' && (
                <input className="field h-9 w-24 shrink-0" inputMode="decimal" disabled={readOnly || !on} placeholder={markup ? `+${markup}%` : 'same'} value={own[i.id] ?? ''} onChange={(e) => setOwn((o) => ({ ...o, [i.id]: e.target.value }))} aria-label={`${i.name} price on this channel`} />
              )}
            </div>
          );
        })}
        {catalog && shown.length === 0 && <p className="p-4 text-sm text-muted-foreground">No item matches.</p>}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Photos, prices and descriptions are sent with the menu. Change them in Menu creation.</p>

      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-ghost" onClick={onClose}>Close</button>
        {!readOnly && <>
          <button className="btn-ghost ml-auto" disabled={busy !== null || !catalog} onClick={() => void save(true)}><RefreshCw className={`h-4 w-4 ${busy === 'sync' ? 'animate-spin' : ''}`} />{state?.hub ? 'Save and sync now' : 'Save'}</button>
          <button className="btn-primary" disabled={busy !== null || !catalog} onClick={() => void save(false)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </>}
      </div>
    </Modal>
  );
}
