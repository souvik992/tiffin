import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { StoreInfo, StoreInput } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { fitLogo, toBase64, toMono, trimRows } from '../lib/logo.ts';
import type { MonoLogo } from '../lib/logo.ts';

type Field = keyof StoreInput;
const SIZES: Array<[string, number]> = [['Small', 192], ['Medium', 288], ['Large', 384]];

/** Settings > Store settings: the bill logo, then the details every bill prints (from the database). They sit above
 * the bill design and share its preview; onChanged refreshes that preview. */
export function StoreSettings({ onChanged }: { onChanged: () => void }) {
  const { api, user, fail, notify } = useSession();
  const isOwner = user?.role === 'owner';
  const key = useRef(newKey());
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [form, setForm] = useState<StoreInput | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.store().then((s) => { setStore(s); setForm({ name: s.name, address: s.address, phone: s.phone, gstin: s.gstin, fssaiNo: s.fssaiNo }); }).catch(fail), [api, fail]);
  useEffect(() => { void load(); }, [load]);
  const set = (f: Field, v: string) => { setForm((x) => x && { ...x, [f]: v }); setErrors((e) => ({ ...e, [f]: undefined })); };
  const save = async () => {
    if (!form) return;
    setBusy(true); setErrors({});
    try {
      const r = await api.saveStore(form, key.current);
      key.current = newKey();
      notify('success', r.changed.length ? 'Store details saved. New bills use them; earlier bills keep the details they were issued with.' : 'Nothing changed.');
      await load(); onChanged();
    } catch (e) {
      key.current = newKey();
      const fields = e instanceof ApiError ? (e.details as { fields?: Partial<Record<Field, string>> } | null)?.fields : undefined;
      if (fields) setErrors(fields); else fail(e);
    } finally { setBusy(false); }
  };

  if (!store || !form) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const input = (f: Field, label: string, o: { placeholder?: string; hint?: string; upper?: boolean; area?: boolean } = {}) => (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {o.area
        ? <textarea className="field h-auto w-full py-2" rows={3} disabled={!isOwner} value={form[f] ?? ''} placeholder={o.placeholder} onChange={(e) => set(f, e.target.value)} aria-invalid={Boolean(errors[f])} />
        : <input className="field w-full" disabled={!isOwner} value={form[f] ?? ''} placeholder={o.placeholder} onChange={(e) => set(f, o.upper ? e.target.value.toUpperCase() : e.target.value)} aria-invalid={Boolean(errors[f])} />}
      {errors[f] ? <span role="alert" className="mt-1 block text-xs text-destructive">{errors[f]}</span> : o.hint && <span className="mt-1 block text-xs text-muted-foreground">{o.hint}</span>}
    </label>
  );

  const details = (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4" aria-label="Store details">
      <div>
        <h3 className="font-semibold">Store details</h3>
        <p className="text-xs text-muted-foreground">Printed at the top of every bill. Changes apply to new bills; a bill already issued (and its reprints) keeps the details it was issued with.</p>
      </div>
      {input('name', 'Store name', { placeholder: 'The Local Diners' })}
      {input('address', 'Address', { area: true, placeholder: '#2075, 4th Cross, 2nd Block\nKalyan Nagar\nBangalore-560 043', hint: 'Up to 4 lines, printed under the logo as you type them.' })}
      {input('phone', 'Phone', { placeholder: '080 4144 0067' })}
      {input('gstin', 'GSTIN', { upper: true, placeholder: '29ABCDE1234F1Z5', hint: `15 characters, from the GST certificate. Must be for state ${store.stateCode}, where this store was set up. Leave empty if not registered.` })}
      {input('fssaiNo', 'FSSAI licence number', { placeholder: '14 digits' })}
      {isOwner ? <button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save store details'}</button>
        : <p className="text-sm text-muted-foreground">Only the owner can change the store details.</p>}
    </section>
  );
  return (
    <>
      <LogoCard store={store} isOwner={isOwner} onChanged={() => { void load(); onChanged(); }} />
      {details}
    </>
  );
}

function LogoCard({ store, isOwner, onChanged }: { store: StoreInfo; isOwner: boolean; onChanged: () => void }) {
  const { api, fail, notify } = useSession();
  const key = useRef(newKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState(288);
  const [threshold, setThreshold] = useState(128);
  const [photo, setPhoto] = useState(false);
  const [mono, setMono] = useState<MonoLogo | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const choose = (f: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) { setProblem('Choose a picture (PNG, JPG, WebP, GIF or BMP).'); return; }
    if (f.size > 10_000_000) { setProblem('The picture is too large (over 10 MB).'); return; }
    const url = URL.createObjectURL(f);
    const i = new Image();
    i.onload = () => { setImg(i); setProblem(null); URL.revokeObjectURL(url); };
    i.onerror = () => { setProblem('This picture could not be opened. Try saving it as PNG or JPG.'); URL.revokeObjectURL(url); };
    i.src = url;
  };

  // convert to printer dots whenever the picture or a setting changes, and draw the result
  useEffect(() => {
    if (!img) { setMono(null); return; }
    const { width, height } = fitLogo(img.naturalWidth, img.naturalHeight, size);
    const work = document.createElement('canvas');
    work.width = width; work.height = height;
    const g = work.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0, width, height);
    const m = trimRows(toMono(g.getImageData(0, 0, width, height).data, width, height, { threshold, dither: photo }));
    setMono(m);
    const c = canvas.current;
    if (!c) return;
    c.width = m.width; c.height = m.height;
    const out = c.getContext('2d')!.createImageData(m.width, m.height);
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      const black = (m.bits[y * (m.width / 8) + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
      const o = (y * m.width + x) * 4;
      out.data[o] = out.data[o + 1] = out.data[o + 2] = black ? 0 : 255; out.data[o + 3] = 255;
    }
    c.getContext('2d')!.putImageData(out, 0, 0);
  }, [img, size, threshold, photo]);

  const save = async () => {
    if (!mono) return;
    setBusy(true);
    try {
      await api.setLogo({ width: mono.width, height: mono.height, bitsBase64: toBase64(mono.bits) }, key.current);
      key.current = newKey(); setImg(null);
      notify('success', 'Logo saved. It prints at the top of every new bill.');
      onChanged();
    } catch (e) { key.current = newKey(); setProblem(messageOf(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.clearLogo(key.current); key.current = newKey(); notify('success', 'Logo removed from bills.'); onChanged(); } catch (e) { key.current = newKey(); fail(e); } finally { setBusy(false); }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4" aria-label="Bill logo">
      <div>
        <h3 className="font-semibold">Bill logo</h3>
        <p className="text-xs text-muted-foreground">Printed at the top of the bill, above the store name, in black and white. A simple, dark logo on a white background prints best.</p>
      </div>
      {!img && (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-background p-3">
          {store.logo ? <img src={api.logoUrl(store.logo.updatedAt)} alt="Current logo" className="max-h-20 max-w-[50%] bg-white" style={{ imageRendering: 'pixelated' }} /> : <p className="text-sm text-muted-foreground">No logo yet.</p>}
          {store.logo && <span className="ml-auto text-xs text-muted-foreground">{store.logo.width} x {store.logo.height} dots</span>}
        </div>
      )}
      {img && (
        <div className="space-y-3 rounded-xl border border-primary p-3">
          <p className="text-sm font-medium">As it will print:</p>
          <div className="flex justify-center rounded-lg border border-border bg-white p-2"><canvas ref={canvas} aria-label="Logo as it will print" className="max-w-full" style={{ imageRendering: 'pixelated', width: mono ? `${mono.width / 2}px` : undefined }} /></div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Logo size">
            <span className="text-sm">Size</span>
            {SIZES.map(([label, w]) => <button key={w} className={`chip ${size === w ? 'chip-active' : ''}`} onClick={() => setSize(w)}>{label}</button>)}
          </div>
          <label className="flex items-center gap-3 text-sm">Darkness
            <input type="range" min={40} max={230} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="flex-1" aria-label="Darkness" />
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />Photo or shaded logo (prints shades as dots)</label>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || !mono} onClick={() => void save()}>{busy ? 'Saving…' : 'Use this logo'}</button>
            <button className="btn-ghost" onClick={() => setImg(null)}>Cancel</button>
          </div>
        </div>
      )}
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      {isOwner ? (
        <div className="flex flex-wrap gap-2">
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" className="hidden" aria-label="Logo picture" onChange={(e) => choose(e.target.files?.[0])} />
          {!img && <button className="btn-ghost" onClick={() => fileInput.current?.click()}><ImagePlus className="h-4 w-4" />{store.logo ? 'Change logo' : 'Upload logo'}</button>}
          {!img && store.logo && <button className="btn-ghost" disabled={busy} onClick={() => void remove()}><Trash2 className="h-4 w-4" />Remove logo</button>}
        </div>
      ) : <p className="text-sm text-muted-foreground">Only the owner can change the logo.</p>}
    </section>
  );
}
