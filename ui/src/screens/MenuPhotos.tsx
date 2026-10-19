import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, ImagePlus, Upload } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Catalog } from '../lib/api.ts';
import { useSession, messageOf } from '../lib/session.tsx';
import { preparePhoto, sizeText } from '../lib/photo.ts';
import { matchPhotos } from '../lib/photoMatch.ts';
import type { PhotoMatch } from '../lib/photoMatch.ts';

const MAX_FILES = 300;
const PHOTO_TYPES = /\.(jpe?g|png|webp)$/i;
interface Row extends PhotoMatch { f: File; url: string; chosen: string | null; state: 'ready' | 'done' | 'failed' | 'skipped'; error?: string }

/** Menu creation > Bulk photos: many photos at once, matched to items by file name ("Cheese Burger.jpg"). */
export function MenuPhotos({ catalog, canEdit, reload }: { catalog: Catalog; canEdit: boolean; reload: () => Promise<void> }) {
  const { api, notify } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [keepExisting, setKeepExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const items = useMemo(() => [...catalog.items].sort((a, b) => a.name.localeCompare(b.name)), [catalog.items]);
  const byId = useMemo(() => new Map(catalog.items.map((i) => [i.id, i])), [catalog.items]);
  useEffect(() => () => rows.forEach((r) => URL.revokeObjectURL(r.url)), [rows]);

  const take = (list: FileList | null) => {
    if (!list) return;
    const all = [...list];
    const photos = all.filter((f) => PHOTO_TYPES.test(f.name)).slice(0, MAX_FILES);
    const skipped = all.length - photos.length;
    setNote(skipped ? `${skipped} file(s) left out: only JPG, PNG and WebP photos, at most ${MAX_FILES} at a time.` : null);
    rows.forEach((r) => URL.revokeObjectURL(r.url));
    const m = matchPhotos(photos.map((f) => f.name), catalog.items);
    setRows(m.map((x, i) => ({ ...x, f: photos[i]!, url: URL.createObjectURL(photos[i]!), chosen: x.itemId, state: 'ready' })));
  };
  const choose = (i: number, id: string | null) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, chosen: id } : r)));

  const chosenCount = new Map<string, number>();
  rows.forEach((r) => { if (r.chosen) chosenCount.set(r.chosen, (chosenCount.get(r.chosen) ?? 0) + 1); });
  const clash = (r: Row) => Boolean(r.chosen && (chosenCount.get(r.chosen) ?? 0) > 1);
  const willUpload = (r: Row) => r.state === 'ready' && r.chosen && !clash(r) && !(keepExisting && byId.get(r.chosen)?.imageFile);
  const ready = rows.filter(willUpload);

  const upload = async () => {
    setBusy(true);
    const todo = rows.map((r, i) => [r, i] as const).filter(([r]) => willUpload(r));
    setProgress({ done: 0, total: todo.length });
    let ok = 0, failed = 0, before = 0, after = 0;
    for (const [r, i] of todo) { // one at a time: gentle on a small shop PC
      try {
        const p = await preparePhoto(r.f);
        URL.revokeObjectURL(p.previewUrl);
        await api.setItemImage(r.chosen!, p.dataBase64, newKey());
        ok++; before += p.originalBytes; after += p.bytes;
        setRows((rs) => rs.map((x, j) => (j === i ? { ...x, state: 'done' } : x)));
      } catch (e) {
        failed++;
        setRows((rs) => rs.map((x, j) => (j === i ? { ...x, state: 'failed', error: messageOf(e) } : x)));
      }
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    }
    setBusy(false);
    await reload();
    notify(failed ? 'error' : 'success', failed ? `${ok} photo(s) saved, ${failed} could not be saved (see the list).` : `${ok} photo(s) saved, compressed from ${sizeText(before)} to ${sizeText(after)}. They show on the billing screen now.`);
  };

  if (!canEdit) return <p className="text-sm text-muted-foreground">Only a manager or owner can change menu photos.</p>;
  return (
    <div className="max-w-5xl space-y-4">
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-1 font-semibold">Add many photos at once</h2>
        <ol className="mb-3 list-decimal space-y-0.5 pl-5 text-sm text-muted-foreground">
          <li>Put the photos in one folder and name each like its item: <b>Cheese Burger.jpg</b>, <b>Brownie.png</b>. The item's SKU or barcode also works as a name.</li>
          <li>Choose them all below (Ctrl+A in the folder), or drag them in.</li>
          <li>Check the list, pick the item for any photo that did not match, then press <b>Save photos</b>.</li>
        </ol>
        <p className="mb-3 text-xs text-muted-foreground">Pictures pasted inside Excel cannot be read; use photo files. Each photo is compressed for the menu (at most 1024 px, high quality), like a single photo.</p>
        <button type="button" disabled={busy} onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) take(e.dataTransfer.files); }}
          className={`flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-sm transition-colors ${over ? 'border-primary bg-accent' : 'border-border hover:border-primary'}`}>
          <ImagePlus className="h-8 w-8 text-primary" /><span className="font-semibold">Choose photos</span><span className="text-xs text-muted-foreground">or drop them here (JPG, PNG, WebP)</span>
        </button>
        <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Photo files" onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
        {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      </section>

      {rows.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <p className="text-sm"><b>{rows.filter((r) => r.chosen).length}</b> of {rows.length} matched{rows.some((r) => !r.chosen && r.state === 'ready') && <span className="text-destructive"> · pick the item for the others or leave them out</span>}</p>
            <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={keepExisting} onChange={(e) => setKeepExisting(e.target.checked)} />Keep photos items already have</label>
            <button className="btn-primary" disabled={busy || ready.length === 0} onClick={() => void upload()}><Upload className="h-4 w-4" />{busy && progress ? `Saving ${progress.done} of ${progress.total}…` : `Save ${ready.length} photo${ready.length === 1 ? '' : 's'}`}</button>
          </div>
          <table className="table">
            <thead className="bg-muted text-left"><tr><th className="w-20 p-2">Photo</th><th>File</th><th>Menu item</th><th className="pr-3">Status</th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const item = r.chosen ? byId.get(r.chosen) : null;
                const status = r.state === 'done' ? <span className="flex items-center gap-1 text-primary"><CheckCircle2 className="h-4 w-4" />Saved</span>
                  : r.state === 'failed' ? <span className="flex items-center gap-1 text-destructive"><CircleAlert className="h-4 w-4" />{r.error}</span>
                  : !r.chosen ? <span className="text-muted-foreground">{r.how === 'duplicate' ? `Same item as ${r.duplicateOf}: left out` : 'No match: left out'}</span>
                  : clash(r) ? <span className="text-destructive">Two photos for this item: pick one</span>
                  : keepExisting && item?.imageFile ? <span className="text-muted-foreground">Has a photo: kept</span>
                  : <span>{item?.imageFile ? 'Replaces the current photo' : 'New photo'}{r.chosen === r.itemId && r.how !== 'name' && r.how !== 'none' ? ` (by ${r.how === 'sku' ? 'SKU' : 'barcode'})` : ''}</span>;
                return (
                  <tr key={`${r.file}-${i}`} className="border-t border-border">
                    <td className="p-2"><img src={r.url} alt="" className="h-12 w-16 rounded-lg bg-muted object-cover" /></td>
                    <td className="max-w-[14rem] truncate text-sm" title={r.file}>{r.file}</td>
                    <td>
                      <select className="field h-9 w-full max-w-xs" value={r.chosen ?? ''} disabled={busy || r.state === 'done'} onChange={(e) => choose(i, e.target.value || null)} aria-label={`Menu item for ${r.file}`}>
                        <option value="">— leave out —</option>
                        {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                      </select>
                    </td>
                    <td className="pr-3 text-sm">{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
