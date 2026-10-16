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
interface Form { location: ServiceabilityConfig['location']; zones: ZoneForm[]; packagingFee: string; pickupMin: string; pickupEta: string; hours: Hours }
const toForm = (c: ServiceabilityConfig): Form => ({
  location: c.location,
  zones: c.zones.map((z) => ({ upToKm: String(z.upToKm), deliveryFee: money.paiseToInput(z.deliveryFee), minOrder: money.paiseToInput(z.minOrder), freeDeliveryAbove: z.freeDeliveryAbove === null ? '' : money.paiseToInput(z.freeDeliveryAbove), etaMinutes: String(z.etaMinutes) })),
  packagingFee: money.paiseToInput(c.packagingFee), pickupMin: money.paiseToInput(c.pickup.minOrder), pickupEta: String(c.pickup.etaMinutes),
  hours: structuredClone(c.hours),
});
/** The form as the backend expects it; a typo becomes NaN/-1 so the backend names the field. */
const fromForm = (f: Form): unknown => {
  const rupees = (s: string) => money.parseRupees(s) ?? -1;
  return {
    location: f.location,
    zones: f.zones.map((z): Zone => ({ upToKm: Number(z.upToKm), deliveryFee: rupees(z.deliveryFee), minOrder: rupees(z.minOrder), freeDeliveryAbove: z.freeDeliveryAbove.trim() ? rupees(z.freeDeliveryAbove) : null, etaMinutes: Number(z.etaMinutes) })),
    packagingFee: rupees(f.packagingFee), pickup: { minOrder: rupees(f.pickupMin), etaMinutes: Number(f.pickupEta) }, hours: f.hours,
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

  useEffect(() => { api.request<ServiceabilityConfig>('GET', `${BASE}/serviceability`).then((c) => { const f = toForm(c); setForm(f); setSaved(JSON.stringify(f)); }).catch((e) => notify('error', messageOf(e))); }, [api, notify]);
  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const set = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); setErrors({}); };
  const setZone = (i: number, patch: Partial<ZoneForm>) => set({ zones: form.zones.map((z, j) => (j === i ? { ...z, ...patch } : z)) });
  const err = (k: string) => (errors[k] ? <span role="alert" className="mt-1 block text-xs text-destructive">{errors[k]}</span> : null);
  const changed = JSON.stringify(form) !== saved;

  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const c = await api.request<ServiceabilityConfig>('PUT', `${BASE}/serviceability`, fromForm(form), key.current);
      key.current = newKey();
      const f = toForm(c); setForm(f); setSaved(JSON.stringify(f));
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
      <p className="mb-4 text-sm text-muted-foreground">Where this store delivers, what it charges, and when it takes online orders. Distances are straight-line from the store; roads can be about 30% longer.</p>
      <div className="grid gap-4 2xl:grid-cols-2">
        <LocationCard form={form} online={online?.enabled === true} readOnly={ro} onChange={(location) => set({ location })} error={errors.location} />
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
            <p className="text-xs text-muted-foreground sm:col-span-3">GST on delivery and packaging charges will be added to the bill when online orders are billed. Your CA should confirm the rate.</p>
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

function LocationCard({ form, online, readOnly, onChange, error }: { form: Form; online: boolean; readOnly: boolean; onChange: (l: Form['location']) => void; error?: string }) {
  const { api } = useSession();
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const circles = useRef<L.Circle[]>([]);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ label: string; lat: number; lng: number }> | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const loc = form.location;

  // the map itself (only in online mode: tiles come from the internet through the POS)
  useEffect(() => {
    if (!online || !div.current || map.current) return;
    addCss();
    const m = L.map(div.current, { center: loc ? [loc.lat, loc.lng] : BENGALURU, zoom: loc ? 13 : 11 });
    L.tileLayer(`/api${BASE}/tiles/{z}/{x}/{y}.png`, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
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

  const search = async () => {
    setSearchError(null); setResults(null);
    try { setResults(await api.request('GET', `${BASE}/geocode?q=${encodeURIComponent(q)}`)); } catch (e) { setSearchError(messageOf(e)); }
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-4" aria-label="Store location">
      <h3 className="mb-1 flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4 text-primary" />Store location</h3>
      <p className="mb-3 text-xs text-muted-foreground">Search the address, then drag the pin to the exact door (or click the map). Delivery distances are measured from here.</p>
      {online ? (
        <>
          {!readOnly && (
            <div className="mb-2 flex gap-2">
              <input className="field flex-1" placeholder="Shop address, area or landmark" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} aria-label="Search address" />
              <button className="btn-ghost" onClick={() => void search()}><Search className="h-4 w-4" />Search</button>
            </div>
          )}
          {searchError && <p role="alert" className="mb-2 text-sm text-destructive">{searchError}</p>}
          {results && (
            <ul className="mb-2 divide-y divide-border rounded-xl border border-border" aria-label="Search results">
              {results.length === 0 && <li className="p-2 text-sm text-muted-foreground">Nothing found. Try a nearby landmark, or click the map.</li>}
              {results.map((r) => (
                <li key={`${r.lat},${r.lng}`}><button className="w-full p-2 text-left text-sm hover:bg-secondary" onClick={() => { onChange({ lat: round(r.lat), lng: round(r.lng), label: r.label }); setResults(null); }}>{r.label}</button></li>
              ))}
            </ul>
          )}
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
