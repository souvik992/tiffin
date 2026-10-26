import { useCallback, useEffect, useRef, useState } from 'react';
import { ChefHat, FileUp, RotateCcw } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { KotMode, KotSettings as Settings, KotSlot } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { ReceiptLines } from '../components/print.tsx';

const MODES: Array<[KotMode, string, string]> = [
  ['stations', 'On prep station printers', 'Each prep station gets its own ticket on its printer (Settings, Printer setup).'],
  ['with_bill', 'With the bill', 'The tickets print on the receipt printer right after the bill, one per prep station.'],
  ['off', 'Off', 'No kitchen tickets.'],
];
const SLOTS: Array<[KotSlot, string, string]> = [
  ['customer', 'Customer KOT', 'Printed with the bill (mode "With the bill").'],
  ['station', 'Prep station KOT', 'Printed at the prep station printers.'],
  ['online', 'Online order KOT', 'Online orders (app, website, Swiggy, Zomato), in either mode.'],
];

/** Settings > Store settings > Kitchen tickets (KOT): how they print, and the three ticket designs with a preview. */
export function KotSettings() {
  const { api, user, notify, fail } = useSession();
  const isOwner = user?.role === 'owner';
  const [s, setS] = useState<Settings | null>(null);
  const [slot, setSlot] = useState<KotSlot>('customer');
  const [width, setWidth] = useState<58 | 80>(80);
  const [preview, setPreview] = useState<{ name: string; lines: string[] } | null>(null);
  const [pending, setPending] = useState<{ slot: KotSlot; fileName: string; content: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSlot = useRef<KotSlot>('customer');

  useEffect(() => { api.kotSettings().then((x) => { setS(x); if (x.mode === 'stations') setSlot('station'); }).catch(fail); }, [api, fail]);
  const show = useCallback(() => {
    const file = pending?.slot === slot ? { fileName: pending.fileName, content: pending.content } : undefined;
    api.previewKotDesign(slot, width, file).then((p) => { setPreview(p); setErrors([]); })
      .catch((e) => { setPreview(null); setErrors(e instanceof ApiError ? ((e.details as { errors?: string[] } | null)?.errors ?? [e.message]) : [messageOf(e)]); });
  }, [api, slot, width, pending]);
  useEffect(show, [show]);

  if (!s) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const setMode = async (mode: KotMode) => {
    setBusy(true);
    try { setS(await api.setKotMode(mode, newKey())); setSlot(mode === 'with_bill' ? 'customer' : mode === 'stations' ? 'station' : slot); notify('success', mode === 'off' ? 'Kitchen tickets switched off.' : 'Saved. New bills print kitchen tickets this way.'); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const choose = async (f: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!f) return;
    if (f.size > 40_000) { setErrors(['The file is too large. Is this the right file?']); return; }
    setPending({ slot: uploadSlot.current, fileName: f.name, content: await f.text() });
    setSlot(uploadSlot.current);
  };
  const use = async () => {
    if (!pending) return;
    setBusy(true);
    try { setS(await api.setKotDesign(pending.slot, { fileName: pending.fileName, content: pending.content }, newKey())); notify('success', 'KOT design saved. New tickets print with it.'); setPending(null); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const standard = async (x: KotSlot) => {
    setBusy(true);
    try { setS(await api.clearKotDesign(x, newKey())); notify('success', 'Back to the standard design.'); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-4" aria-label="Kitchen tickets">
      <h3 className="flex items-center gap-2 font-semibold"><ChefHat className="h-4 w-4 text-primary" />Kitchen tickets (KOT)</h3>
      <p className="mb-3 text-xs text-muted-foreground">Tickets are split by prep station (Menu creation, Prep stations). A ticket prints only what the kitchen has not had yet, so a KOT sent from the cart is not printed again on billing.</p>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-4">
          <div role="radiogroup" aria-label="How kitchen tickets print" className="space-y-2">
            {MODES.map(([m, label, hint]) => (
              <label key={m} className={`flex cursor-pointer gap-3 rounded-xl border-2 p-3 text-sm ${s.mode === m ? 'border-primary bg-primary/5' : 'border-border'} ${!isOwner ? 'cursor-default opacity-80' : ''}`}>
                <input type="radio" name="kot-mode" checked={s.mode === m} disabled={!isOwner || busy} onChange={() => void setMode(m)} className="mt-0.5" />
                <span><span className="font-semibold">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
              </label>
            ))}
            {!isOwner && <p className="text-xs text-muted-foreground">Only the owner can change this.</p>}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Ticket designs</p>
            {SLOTS.map(([x, label, hint]) => (
              <div key={x} className={`rounded-xl border p-3 text-sm ${slot === x ? 'border-primary' : 'border-border'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSlot(x)} aria-label={`Preview the ${label}`}>
                    <span className="font-semibold">{label}</span>
                    <span className="block text-xs text-muted-foreground">{hint} Design: {s.slots[x].custom ? `${s.slots[x].name} (${s.slots[x].custom!.fileName})` : 'standard'}.</span>
                  </button>
                  {isOwner && <button className="btn-ghost h-9" disabled={busy} onClick={() => { uploadSlot.current = x; fileInput.current?.click(); }}><FileUp className="h-4 w-4" />Upload</button>}
                  {isOwner && s.slots[x].custom && <button className="btn-ghost h-9" disabled={busy} onClick={() => void standard(x)}><RotateCcw className="h-4 w-4" />Standard</button>}
                </div>
              </div>
            ))}
            <input ref={fileInput} type="file" accept={s.extension} className="hidden" aria-label="KOT design file" onChange={(e) => void choose(e.target.files?.[0])} />
            <p className="text-xs text-muted-foreground">Design files end in {s.extension}. The safety marks (REPRINT, ADD-ON, CANCEL) always print.</p>
          </div>
          {pending && (
            <div className="rounded-xl border border-primary bg-primary/5 p-3 text-sm">
              <p className="font-medium">{pending.fileName}: check the preview, then use it for the {SLOTS.find(([x]) => x === pending.slot)![1]}.</p>
              <div className="mt-2 flex gap-2">
                <button className="btn-primary h-9" disabled={busy || errors.length > 0} onClick={() => void use()}>Use this design</button>
                <button className="btn-ghost h-9" onClick={() => { setPending(null); setErrors([]); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        <div className="rounded-2xl border border-border bg-background p-4 xl:sticky xl:top-0 xl:self-start">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">KOT preview{preview ? `: ${preview.name}` : ''}</h4>
            <div className="ml-auto flex gap-2">{([80, 58] as const).map((w) => <button key={w} className={`chip ${width === w ? 'chip-active' : ''}`} onClick={() => setWidth(w)}>{w} mm</button>)}</div>
          </div>
          <div className="mb-2 flex flex-wrap gap-2" role="tablist" aria-label="Which ticket">
            {SLOTS.map(([x, label]) => <button key={x} role="tab" aria-selected={slot === x} className={`chip ${slot === x ? 'chip-active' : ''}`} onClick={() => setSlot(x)}>{label}</button>)}
          </div>
          {errors.length > 0 && <ul role="alert" className="mb-2 list-disc rounded-lg bg-destructive/10 p-2 pl-6 text-xs text-destructive">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <div className="overflow-auto rounded-lg border border-border bg-white p-3">
            {preview ? <ReceiptLines lines={preview.lines} logoUrl="" className="mx-auto w-fit text-[11px]" /> : <p className="text-sm text-muted-foreground">No preview.</p>}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">A sample ticket with made-up items.</p>
        </div>
      </div>
    </section>
  );
}
