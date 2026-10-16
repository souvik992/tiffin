import { useEffect, useRef, useState } from 'react';
import { MapPin, Plus, Search, Trash2 } from 'lucide-react';
import L from 'leaflet';
import leafletCss from 'leaflet/dist/leaflet.css';
import { BASE, host } from './host.ts';
import { useOnlineConfig } from './online.ts';
import type { Hours, ServiceabilityConfig, Slot, Zone } from '../../../contract/src/serviceability.ts';

const { useSession, newKey, messageOf, money } = host;
const DAYS: Array<[keyof Hours, string]> = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']];
const COLORS = ['#16a34a', '#2563eb', '#d97706', '#9333ea', '#dc2626', '#0891b2'];
const BENGALURU: [number, number] = [12.9716, 77.5946];

let cssAdded = false;
const addCss = () => { if (cssAdded) return; cssAdded = true; const s = document.createElement('style'); s.textContent = leafletCss; document.head.appendChild(s); };

/** Amounts are typed as rupees and stored as paise (the POS's money rules: no floating point). */
interface ZoneForm { upToKm: string; deliveryFee: string; minOrder: string; freeDeliveryAbove: string; etaMinutes: string }
/** Which map the POS uses: Google when the owner saved a key in Settings > API keys, else OpenStreetMap. */
interface MapsInfo { provider: 'google' | 'osm'; attribution: string }
type Saved = ServiceabilityConfig & { feeTaxGroupId: string | null; maps: MapsInfo };
interface TaxGroup { id: string; name: string; rateBp: number }
interface Form {
  location: ServiceabilityConfig['location']; zones: ZoneForm[]; packagingFee: string; pickupMin: string; pickupEta: string; hours: Hours;
  roadFactor: string; feeTaxGroupId: string;
}
const toForm = (c: Saved): Form => ({
  location: c.location,
  zones: c.zones.map((z) => ({ upToKm: String(z.upToKm), deliveryFee: money.paiseToInput(z.deliveryFee), minOrder: money.paiseToInput(z.minOrder), freeDeliveryAbove: z.freeDeliveryAbove === null ? '' : money.paiseToInput(z.freeDeliveryAbove), etaMinutes: String(z.etaMinutes) })),
  packagingFee: money.paiseToInput(c.packagingFee), pickupMin: money.paiseToInput(c.pickup.minOrder), pickupEta: String(c.pickup.etaMinutes),
  hours: structuredClone(c.hours),
  roadFactor: (c.roadFactor ?? 1.3).toFixed(2), feeTaxGroupId: c.feeTaxGroupId ?? '',
});
/** The form as the backend expects it; a typo becomes NaN/-1 so the backend names the field. */
const fromForm = (f: Form): unknown => {
  const rupees = (s: string) => money.parseRupees(s) ?? -1;
  return {
    location: f.location,
    zones: f.zones.map((z): Zone => ({ upToKm: Number(z.upToKm), deliveryFee: rupees(z.deliveryFee), minOrder: rupees(z.minOrder), freeDeliveryAbove: z.freeDeliveryAbove.trim() ? rupees(z.freeDeliveryAbove) : null, etaMinutes: Number(z.etaMinutes) })),
    packagingFee: rupees(f.packagingFee), pickup: { minOrder: rupees(f.pickupMin), etaMinutes: Number(f.pickupEta) }, hours: f.hours,
    roadFactor: Number(f.roadFactor), feeTaxGroupId: f.feeTaxGroupId || null,
  };
};

/** Settings > Serviceability: where and when this store delivers, and what it charges. */
export function Serviceability() {
  const { api, user, notify } = useSession();
  const isOwner = user?.role === 'owner';
  const online = useOnlineConfig();
  const key = useRef(newKey());
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [taxGroups, setTaxGroups] = useState<TaxGroup[]>([]);
  const [maps, setMaps] = useState<MapsInfo | null>(null);

  useEffect(() => {
    api.request<Saved>('GET', `${BASE}/serviceability`).then((c) => { const f = toForm(c); setForm(f); setSaved(JSON.stringify(f)); setMaps(c.maps); }).catch((e) => notify('error', messageOf(e)));
    api.request<TaxGroup[]>('GET', `${BASE}/tax-groups`).then(setTaxGroups).catch(() => setTaxGroups([]));
  }, [api, notify]);
  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const set = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); setErrors({}); };
  const setZone = (i: number, patch: Partial<ZoneForm>) => set({ zones: form.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) });
  const err = (k: string) => (errors[k] ? <span role="alert" className="mt-1 block text-xs text-destructive">{errors[k]}</span> : null);
  const changed = JSON.stringify(form) !== saved;

  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const c = await api.request<Saved>('PUT', `${BASE}/serviceability`, fromForm(form), key.current);
      key.current = newKey();
      const f = toForm(c); setForm(f); setSaved(JSON.stringify(f)); setMaps(c.maps);
      notify('success', 'Serviceability saved. It is sent to the online order hub when that is connected.');
    } catch (e) {
      key.current = newKey();
      const fields = (e as { details?: { fields?: Record<string, string> } }).details?.fields;
      if (fields) { setErrors(fields); notify('error', 'Some values need fixing. They are marked in red.'); } else notify('error', messageOf(e));
    } finally { setBusy(false); }
  };

  const ro = !isOwner;
  return (
    <>
      <h2 className="mb-1 font-display text-2xl">Serviceability</h2>
      <p className="mb-4 text-sm text-muted-foreground">Where this store delivers, what it charges, and when it takes online orders. Distances are road distances: measured on the road map when the order hub has it, otherwise the straight line times the road factor below.</p>
      <div className="grid gap-4 2xl:grid-cols-2">
        <div className="space-y-4">
          <LocationCard key={maps?.provider ?? 'none'} form={form} online={online?.enabled === true} readOnly={ro} maps={maps} onChange={(location) => set({ location })} error={errors.location} />
        </div>
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card p-4" aria-label="Delivery areas">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="font-semibold">Delivery areas</h3>
              {!ro && form.zones.length < 6 && (
                <button className="btn-ghost ml-auto h-9" onClick={() => set({ zones: [...form.zones, { upToKm: String(Number(form.zones.at(-1)?.upToKm ?? 0) + 2), deliveryFee: '50', minOrder: '200', freeDeliveryAbove: '', etaMinutes: '60' }] })}><Plus className="h-4 w-4" />Add area</button>
              )}
            </div>
            <p className="mb-3 text-xs text-muted-foreground">Each area starts where the one above ends. Orders beyond the last area cannot be delivered.</p>
            {form.zones.length === 0 && <p className="text-sm text-muted-foreground">No delivery areas: delivery is off.</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                {form.zones.length > 0 && (
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="pb-1">Area</th><th>Up to (km)</th><th>Delivery fee (Rs)</th><th>Minimum order (Rs)</th><th>Free above (Rs)</th><th>Time (min)</th><th /></tr>
                  </thead>
                )}
                <tbody>
                  {form.zones.map((z, i) => (
                    <tr key={i} className="align-top">
                      <td className="py-1 pr-2"><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="h-3 w-3 rounded-full" style={{ background: COLORS[i] }} />{i === 0 ? '0' : form.zones[i - 1]!.upToKm}+ km</span></td>
                      {(['upToKm', 'deliveryFee', 'minOrder', 'freeDeliveryAbove', 'etaMinutes'] as const).map((k) => (
                        <td key={k} className="py-1 pr-2">
                          <input className="field h-9 w-24" inputMode="decimal" disabled={ro} value={z[k]} placeholder={k === 'freeDeliveryAbove' ? 'never' : ''} onChange={(e) => setZone(i, { [k]: e.target.value })} aria-label={`Area ${i + 1} ${k}`} aria-invalid={Boolean(errors[`zones.${i}.${k}`])} />
                          {err(`zones.${i}.${k}`)}
                        </td>
                      ))}
                      <td className="py-1">{!ro && <button className="btn-ghost h-9 px-2" aria-label={`Remove area ${i + 1}`} onClick={() => set({ zones: form.zones.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {err('zones')}
          </section>

          <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-3" aria-label="Fees and pickup">
            <label className="text-sm font-medium">Packaging fee per order (Rs)
              <input className="field mt-1 w-full" inputMode="decimal" disabled={ro} value={form.packagingFee} onChange={(e) => set({ packagingFee: e.target.value })} aria-label="Packaging fee" />
              {err('packagingFee')}
            </label>
            <label className="text-sm font-medium">Pickup: minimum order (Rs)
              <input className="field mt-1 w-full" inputMode="decimal" disabled={ro} value={form.pickupMin} onChange={(e) => set({ pickupMin: e.target.value })} aria-label="Pickup minimum order" />
            </label>
            <label className="text-sm font-medium">Pickup: ready in (min)
              <input className="field mt-1 w-full" inputMode="numeric" disabled={ro} value={form.pickupEta} onChange={(e) => set({ pickupEta: e.target.value })} aria-label="Pickup ready time" />
            </label>
            {err('pickup')}
            <label className="text-sm font-medium sm:col-span-2">GST on delivery and packaging charges
              <select className="field mt-1 w-full" disabled={ro} value={form.feeTaxGroupId} onChange={(e) => set({ feeTaxGroupId: e.target.value })} aria-label="GST on fees">
                <option value="">Not chosen (delivery and packaging fees cannot be charged)</option>
                {taxGroups.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.rateBp / 100}%)</option>)}
              </select>
              {err('feeTaxGroupId')}
            </label>
            <label className="text-sm font-medium">Road factor
              <input className="field mt-1 w-full" inputMode="decimal" disabled={ro} value={form.roadFactor} onChange={(e) => set({ roadFactor: e.target.value })} aria-label="Road factor" />
              {err('roadFactor')}
            </label>
            <p className="text-xs text-muted-foreground sm:col-span-3">The fees are billed as lines with this GST rate, so the bill and the online price match. Your CA should confirm the rate. Road factor: road distance is about this many times the straight line (1.30 = 30% longer); used when the hub has no road map.</p>
          </section>

          <HoursCard hours={form.hours} readOnly={ro} errors={errors} onChange={(hours) => set({ hours })} />
        </div>
      </div>
      {isOwner ? (
        <div className="sticky bottom-0 mt-4 flex gap-2 border-t border-border bg-background py-3">
          <button className="btn-primary" disabled={busy || !changed} onClick={() => void save()}>{busy ? 'Saving…' : 'Save serviceability'}</button>
          {changed && <button className="btn-ghost" onClick={() => { setForm(JSON.parse(saved) as Form); setErrors({}); }}>Undo changes</button>}
        </div>
      ) : <p className="mt-4 text-sm text-muted-foreground">Only the owner can change serviceability.</p>}
    </>
  );
}

function LocationCard({ form, online, readOnly, maps, onChange, error }: { form: Form; online: boolean; readOnly: boolean; maps: MapsInfo | null; onChange: (l: Form['location']) => void; error?: string }) {
  const { api } = useSession();
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const circles = useRef<L.Circle[]>([]);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const loc = form.location;

  // the map itself (only in online mode: tiles come from the internet through the POS)
  useEffect(() => {
    if (!online || !div.current || map.current) return;
    addCss();
    const m = L.map(div.current, { center: loc ? [loc.lat, loc.lng] : BENGALURU, zoom: loc ? 13 : 11 });
    L.tileLayer(`/api${BASE}/tiles/{z}/{x}/{y}.png?p=${maps?.provider ?? 'osm'}`, { maxZoom: 19, attribution: maps?.attribution ?? '' }).addTo(m);
    if (!readOnly) m.on('click', (e: L.LeafletMouseEvent) => changeRef.current({ lat: round(e.latlng.lat), lng: round(e.latlng.lng), label: '' }));
    map.current = m;
    return () => { m.remove(); map.current = null; marker.current = null; circles.current = []; };
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  // pin and distance circles follow the form
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const c of circles.current) c.remove();
    circles.current = [];
    if (!loc) { marker.current?.remove(); marker.current = null; return; }
    if (!marker.current) {
      const icon = L.divIcon({ className: '', html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#ea580c;border:3px solid #fff;transform:rotate(-45deg);box-shadow:0 1px 4px #0006"></div>', iconSize: [22, 22], iconAnchor: [11, 22] });
      marker.current = L.marker([loc.lat, loc.lng], { icon, draggable: !readOnly, title: 'Store location' }).addTo(m);
      marker.current.on('dragend', () => { const p = marker.current!.getLatLng(); changeRef.current({ lat: round(p.lat), lng: round(p.lng), label: '' }); });
    } else marker.current.setLatLng([loc.lat, loc.lng]);
    [...form.zones].reverse().forEach((z, ri) => {
      const i = form.zones.length - 1 - ri, km = Number(z.upToKm);
      if (Number.isFinite(km) && km > 0) circles.current.push(L.circle([loc.lat, loc.lng], { radius: km * 1000, color: COLORS[i], weight: 2, fillOpacity: 0.06 }).addTo(m));
    });
    const outer = circles.current[0];
    if (outer) m.fitBounds(outer.getBounds(), { padding: [12, 12] }); else m.setView([loc.lat, loc.lng], 14);
  }, [loc?.lat, loc?.lng, JSON.stringify(form.zones.map((z) => z.upToKm)), online]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="rounded-2xl border border-border bg-card p-4" aria-label="Store location">
      <h3 className="mb-1 flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4 text-primary" />Store location
        {maps && <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">{maps.provider === 'google' ? 'Google Maps' : 'OpenStreetMap (free)'}</span>}
      </h3>
      {maps?.provider === 'osm' && <p className="mb-2 rounded-lg bg-accent/50 p-2 text-xs">Using the free map. For Google Maps search and map, the owner adds a Google key in <b>Settings &gt; API keys</b>.</p>}
      <p className="mb-3 text-xs text-muted-foreground">Type the shop name, area or road and pick a suggestion, then drag the pin to the exact door (or click the map). Not found? In Google Maps, right-click your shop, click the numbers at the top to copy them, and paste them here. Delivery distances are measured from here.</p>
      {online ? (
        <>
          {!readOnly && <PlaceSearch near={() => { if (loc) return loc; const c = map.current?.getCenter(); return c ? { lat: c.lat, lng: c.lng } : null; }} onPick={(p) => onChange({ lat: round(p.lat), lng: round(p.lng), label: p.label })} />}
          <div ref={div} className="h-[380px] w-full overflow-hidden rounded-xl border border-border" aria-label="Map" />
        </>
      ) : (
        <p className="rounded-xl border border-border bg-background p-3 text-sm">The map needs the internet. Turn on <b>Online orders</b> (Settings) to see it. You can still type the location below.</p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs font-medium">Latitude
          <input className="field mt-1 w-full" inputMode="decimal" disabled={readOnly} value={loc?.lat ?? ''} onChange={(e) => onChange({ lat: Number(e.target.value), lng: loc?.lng ?? 0, label: loc?.label ?? '' })} aria-label="Latitude" />
        </label>
        <label className="text-xs font-medium">Longitude
          <input className="field mt-1 w-full" inputMode="decimal" disabled={readOnly} value={loc?.lng ?? ''} onChange={(e) => onChange({ lat: loc?.lat ?? 0, lng: Number(e.target.value), label: loc?.label ?? '' })} aria-label="Longitude" />
        </label>
      </div>
      {loc?.label && <p className="mt-2 text-xs text-muted-foreground">{loc.label}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </section>
  );
}

function HoursCard({ hours, readOnly, errors, onChange }: { hours: Hours; readOnly: boolean; errors: Record<string, string>; onChange: (h: Hours) => void }) {
  const setDay = (d: keyof Hours, slots: Slot[]) => onChange({ ...hours, [d]: slots });
  return (
    <section className="rounded-2xl border border-border bg-card p-4" aria-label="Opening hours">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-semibold">Opening hours for online orders</h3>
        {!readOnly && <button className="btn-ghost ml-auto h-9" onClick={() => onChange(Object.fromEntries(DAYS.map(([d]) => [d, structuredClone(hours['1'])])) as Hours)}>Copy Monday to all days</button>}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">Indian time. A closing time earlier than the opening time runs past midnight (e.g. 18:00 to 01:00).</p>
      <div className="divide-y divide-border">
        {DAYS.map(([d, name]) => {
          const slots = hours[d];
          return (
            <div key={d} className="flex flex-wrap items-center gap-2 py-2">
              <span className="w-24 text-sm font-medium">{name}</span>
              {slots.length === 0 && <span className="text-sm text-muted-foreground">Closed</span>}
              {slots.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <input type="time" className="field h-9" disabled={readOnly} value={s.open} onChange={(e) => setDay(d, slots.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} aria-label={`${name} opens`} />
                  <span className="text-xs">to</span>
                  <input type="time" className="field h-9" disabled={readOnly} value={s.close} onChange={(e) => setDay(d, slots.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} aria-label={`${name} closes`} />
                  {!readOnly && <button className="btn-ghost h-9 px-2" aria-label={`Remove ${name} time ${i + 1}`} onClick={() => setDay(d, slots.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>}
                </span>
              ))}
              {!readOnly && slots.length < 2 && <button className="btn-ghost h-9" onClick={() => setDay(d, [...slots, slots.length ? { open: '18:00', close: '23:00' } : { open: '10:00', close: '22:00' }])}><Plus className="h-4 w-4" />{slots.length ? 'Second time' : 'Open'}</button>}
              {(errors[`hours.${d}`] || errors[`hours.${d}.0`] || errors[`hours.${d}.1`]) && <span role="alert" className="w-full text-xs text-destructive">{errors[`hours.${d}`] ?? errors[`hours.${d}.0`] ?? errors[`hours.${d}.1`]}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

interface Suggestion { label: string; detail: string; lat: number | null; lng: number | null; placeId: string | null }
/** "12.9661, 77.7175" (Google Maps right-click) or a Google Maps link with @12.96,77.71 or ?q=12.96,77.71. */
function pastedPoint(t: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/.exec(t) ?? /[@=](-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(t) ?? /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(t);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return lat >= 6 && lat <= 37 && lng >= 68 && lng <= 98 ? { lat, lng } : null; // inside India
}

/** Suggestions while typing (no need to press Search); arrow keys + Enter, or click. */
function PlaceSearch({ near: nearOf, onPick }: { near: () => { lat: number; lng: number } | null; onPick: (p: { lat: number; lng: number; label: string }) => void }) {
  const { api } = useSession();
  const [q, setQ] = useState('');
  const [list, setList] = useState<Suggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const session = useRef(newKey());
  const point = pastedPoint(q);

  const run = async (text: string, full: boolean) => {
    const id = ++seq.current;
    setBusy(true); setError(null);
    const near = nearOf();
    const nearQ = near ? `&near=${near.lat.toFixed(4)},${near.lng.toFixed(4)}` : '';
    try {
      const out = await api.request<Suggestion[]>('GET', `${BASE}/geocode?q=${encodeURIComponent(text)}${nearQ}${full ? '&full=1' : ''}&session=${session.current}`);
      if (id === seq.current) { setList(out); setActive(0); }
    } catch (e) { if (id === seq.current) { setList(null); setError(messageOf(e)); } }
    finally { if (id === seq.current) setBusy(false); }
  };
  // type-as-you-go: wait until typing pauses
  useEffect(() => {
    const text = q.trim();
    if (text.length < 3 || pastedPoint(text)) { seq.current++; setList(null); setBusy(false); return; }
    const t = setTimeout(() => void run(text, false), 350);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (s: Suggestion) => {
    setError(null);
    try {
      let p = s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng, label: [s.label, s.detail].filter(Boolean).join(', ') } : null;
      if (!p && s.placeId) {
        const d = await api.request<{ lat: number; lng: number; label: string }>('GET', `${BASE}/geocode/place?id=${encodeURIComponent(s.placeId)}&session=${session.current}`);
        p = { ...d, label: d.label.startsWith(s.label) ? d.label : [s.label, d.label].filter(Boolean).join(', ') };
      }
      if (!p) return;
      onPick(p);
      setQ(''); setList(null);
      session.current = newKey(); // a new search session (Google bills per session)
    } catch (e) { setError(messageOf(e)); }
  };
  const usePoint = () => { if (point) { onPick({ ...point, label: '' }); setQ(''); setList(null); } };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && list?.length) { e.preventDefault(); setActive((a) => (a + 1) % list.length); }
    else if (e.key === 'ArrowUp' && list?.length) { e.preventDefault(); setActive((a) => (a - 1 + list.length) % list.length); }
    else if (e.key === 'Escape') setList(null);
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (point) usePoint();
      else if (list?.length) void pick(list[active]!);
      else if (q.trim().length >= 3) void run(q.trim(), true);
    }
  };

  return (
    <div className="relative z-[1100] mb-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input className="field w-full pl-9" placeholder="Shop name, area, road, or paste Google Maps coordinates" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          role="combobox" aria-expanded={Boolean(list || point)} aria-controls="place-suggestions" aria-autocomplete="list" aria-label="Search place" autoComplete="off" />
        {busy && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">Searching…</span>}
      </div>
      {error && <p role="alert" className="mt-1 text-sm text-destructive">{error}</p>}
      {(point || list) && (
        <ul id="place-suggestions" role="listbox" className="absolute z-[1000] mt-1 max-h-80 w-full overflow-auto rounded-xl border border-border bg-card shadow-lg">
          {point && <li role="option" aria-selected><button className="w-full p-2 text-left text-sm hover:bg-secondary" onClick={usePoint}><b>Use this point</b> <span className="text-muted-foreground">{point.lat}, {point.lng}</span></button></li>}
          {list?.length === 0 && <li className="p-2 text-sm text-muted-foreground">No match. Press Enter for a wider search, try the area or road name, or paste the coordinates from Google Maps.</li>}
          {list?.map((s, i) => (
            <li key={`${s.placeId ?? ''}${s.lat},${s.lng},${i}`} role="option" aria-selected={i === active}>
              <button className={`flex w-full items-start gap-2 p-2 text-left text-sm ${i === active ? 'bg-secondary' : 'hover:bg-secondary'}`} onMouseEnter={() => setActive(i)} onClick={() => void pick(s)}>
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span><span className="block font-medium">{s.label}</span>{s.detail && <span className="block text-xs text-muted-foreground">{s.detail}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
