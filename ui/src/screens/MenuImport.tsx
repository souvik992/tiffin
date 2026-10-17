import { useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { Download, FileUp, RotateCcw } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { ImportPreview } from '../lib/api.ts';
import { formatPaise, formatRateBp } from '../lib/money.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { VegMark } from '../components/ui.tsx';
import { TEMPLATE } from '../lib/menuTemplate.ts';
import { saveFile } from '../lib/android.ts';

const MAX_BYTES = 1_500_000; // the backend accepts 2 MB per request

/** Bulk upload: check every row first, then import all of them in one go (or none). */
export function MenuImport({ canEdit, reload, onDone }: { canEdit: boolean; reload: () => Promise<void>; onDone: () => void }) {
  const { api, notify } = useSession();
  const key = useRef(newKey());
  const fileInput = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const downloadTemplate = () => {
    saveFile('menu-template.csv', new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' })).catch((e: Error) => setError(e.message));
  };

  const check = async (text: string) => {
    setError(''); setPreview(null);
    if (!text.trim()) return;
    setBusy(true);
    try { setPreview(await api.previewImport(text)); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again after fixing it
    if (!f) return;
    if (f.size > MAX_BYTES) return setError('That file is too large. Split it into files under 1.5 MB.');
    if (!/\.(csv|txt)$/i.test(f.name)) return setError('Choose a .csv file. In Excel use File, Save As, "CSV UTF-8".');
    const reader = new FileReader();
    reader.onload = () => { const text = String(reader.result ?? ''); setFileName(f.name); setCsv(text); key.current = newKey(); void check(text); };
    reader.onerror = () => setError('The file could not be read. Try saving it again.');
    reader.readAsText(f, 'utf-8');
  };

  const doImport = async () => {
    if (!preview || preview.errors.length || !preview.items.length) return;
    setBusy(true); setError('');
    try {
      const r = await api.importItems(csv, key.current);
      key.current = newKey();
      notify('success', `${r.imported} item${r.imported === 1 ? '' : 's'} added${r.categoriesCreated ? ` and ${r.categoriesCreated} new categor${r.categoriesCreated === 1 ? 'y' : 'ies'} created` : ''}.`);
      setCsv(''); setFileName(''); setPreview(null);
      await reload();
      onDone();
    } catch (e) {
      key.current = newKey();
      if (e instanceof ApiError && e.code === 'IMPORT_ERRORS') void check(csv); // something changed since the preview; show the new errors
      setError(messageOf(e));
    } finally { setBusy(false); }
  };

  const reset = () => { setCsv(''); setFileName(''); setPreview(null); setError(''); key.current = newKey(); };

  if (!canEdit) return <p className="text-sm text-muted-foreground">Only a manager or owner can upload menu items.</p>;
  const ready = !!preview && preview.errors.length === 0 && preview.items.length > 0;

  return (
    <div className="space-y-5">
      <ol className="grid gap-3 md:grid-cols-3">
        <Step n={1} title="Get the template">
          <p>Columns: name, category, price in rupees, tax_percent, hsn, barcode, unit, veg, description (optional, shown on the online menu).</p>
          <p className="mt-1">veg: write <b>veg</b>, <b>non-veg</b>, or leave it empty for items that are not food.</p>
          <button className="btn-ghost mt-3" onClick={downloadTemplate}><Download className="h-4 w-4" />Download template</button>
        </Step>
        <Step n={2} title="Fill it in Excel or Sheets">
          <p>One item per row. A category already on the menu is used (capitals and spaces do not matter); a new one is created for you. Prices include GST.</p>
          <p className="mt-1">Save as <b>CSV UTF-8</b>.</p>
        </Step>
        <Step n={3} title="Upload and check">
          <p>Every row is checked first. Nothing is added unless all rows are correct.</p>
          <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} aria-label="Choose CSV file" />
          <button className="btn-primary mt-3" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp className="h-4 w-4" />Choose CSV file</button>
        </Step>
      </ol>

      <details className="rounded-xl border border-border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-semibold">Or paste rows instead</summary>
        <textarea className="field mt-3 h-36 w-full py-2 font-mono text-xs" spellCheck={false} aria-label="Paste CSV rows"
          placeholder={TEMPLATE} value={csv} onChange={(e) => { setCsv(e.target.value); setFileName(''); setPreview(null); }} />
        <button className="btn-ghost mt-2" disabled={busy || !csv.trim()} onClick={() => { key.current = newKey(); void check(csv); }}>Check rows</button>
      </details>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {busy && !preview && <p className="text-sm text-muted-foreground">Checking…</p>}

      {preview && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h3 className="font-display text-lg">{fileName || 'Pasted rows'}</h3>
            <span className="text-sm text-muted-foreground">{preview.rows} row{preview.rows === 1 ? '' : 's'}</span>
            {preview.errors.length > 0
              ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">{preview.errors.length} to fix</span>
              : <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">All rows look good</span>}
            <button className="btn-ghost ml-auto" onClick={reset}><RotateCcw className="h-4 w-4" />Start over</button>
            <button className="btn-primary" disabled={!ready || busy} onClick={() => void doImport()}>{busy ? 'Importing…' : `Import ${preview.items.length} item${preview.items.length === 1 ? '' : 's'}`}</button>
          </div>
          {preview.errors.length > 0 && (
            <div className="mb-3 rounded-lg border border-destructive/30 p-3">
              <p className="mb-1 text-sm font-semibold">Fix these rows in the file, then choose it again:</p>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-sm">
                {preview.errors.slice(0, 100).map((e, i) => <li key={i}><span className="font-semibold">Row {e.row}:</span> {e.message}</li>)}
                {preview.errors.length > 100 && <li className="text-muted-foreground">and {preview.errors.length - 100} more</li>}
              </ul>
            </div>
          )}
          {preview.items.length > 0 && (
            <p className="mb-2 text-sm">
              {preview.newCategories.length
                ? <>New categor{preview.newCategories.length === 1 ? 'y' : 'ies'} to create: {preview.newCategories.map((c) => <span key={c} className="mr-1 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-primary">{c}</span>)}<span className="text-muted-foreground">Other categories are already on the menu.</span></>
                : <span className="text-muted-foreground">All categories are already on the menu; none will be created.</span>}
            </p>
          )}
          {preview.items.length > 0 && (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr><th className="py-2">Item</th><th>Category</th><th>GST</th><th>Unit</th><th className="text-right">Price</th></tr></thead>
                <tbody>
                  {preview.items.slice(0, 500).map((it, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-1.5"><span className="flex items-center gap-2"><VegMark veg={it.isVeg} />{it.name}</span></td>
                      <td>{it.category}{it.newCategory && <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-primary">new</span>}</td>
                      <td>{formatRateBp(it.taxPercent)}</td>
                      <td>{it.unit}</td>
                      <td className="text-right tabular-nums">{formatPaise(it.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.items.length > 500 && <p className="mt-2 text-xs text-muted-foreground">Showing the first 500 of {preview.items.length} rows.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
      <div className="mb-2 flex items-center gap-2 text-foreground">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{n}</span>
        <span className="font-semibold">{title}</span>
      </div>
      {children}
    </li>
  );
}
