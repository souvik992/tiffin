import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Boxes, Download, Printer, Receipt, RefreshCw, ShieldCheck, UtensilsCrossed } from 'lucide-react';
import type { ReportColType, ReportInfo, ReportRow, ReportTable } from '../lib/api.ts';
import { formatPaise } from '../lib/money.ts';
import { PRESETS, formatDay, formatIstDateTime, presetRange } from '../lib/dates.ts';
import type { Preset } from '../lib/dates.ts';
import { useSession } from '../lib/session.tsx';
import { PageShell } from '../components/ui.tsx';
import { onAndroid, printPage, saveFile } from '../lib/android.ts';

const KEY = 'pos.reports.key';
const GROUP_ICON: Record<string, typeof BarChart3> = { Sales: BarChart3, Items: UtensilsCrossed, Tax: Receipt, Controls: ShieldCheck, Inventory: Boxes };
/** Rows drawn on screen at once; the CSV download always has every row. */
const SCREEN_ROWS = 1000;

const read = (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* storage unavailable */ } };

/** Display only: every number arrives from the backend already added up. */
function show(v: string | number | null | undefined, type: ReportColType): string {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'money') return formatPaise(Number(v));
  if (type === 'date') return formatDay(String(v));
  if (type === 'datetime') return formatIstDateTime(Number(v));
  if (type === 'int') return Number(v).toLocaleString('en-IN');
  return String(v);
}
const numeric = (t: ReportColType) => t === 'money' || t === 'int' || t === 'qty';

export function Reports() {
  const { api, user, fail, notify } = useSession();
  const allowed = user?.role === 'manager' || user?.role === 'owner';
  const [catalog, setCatalog] = useState<ReportInfo[] | null>(null);
  const [key, setKeyState] = useState<string>(() => read(KEY) ?? 'sales-summary');
  const [preset, setPreset] = useState<Preset | 'custom'>('today');
  const [range, setRange] = useState(() => presetRange('today'));
  const [table, setTable] = useState<ReportTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const seq = useRef(0);

  const setKey = (k: string) => { setKeyState(k); write(KEY, k); };
  const choose = (p: Preset) => { setPreset(p); setRange(presetRange(p)); };

  useEffect(() => {
    if (!allowed) return;
    api.reportCatalog().then(setCatalog).catch((e) => { setCatalog([]); fail(e); });
  }, [api, allowed, fail]);

  const load = () => {
    if (!allowed) return;
    const mine = ++seq.current; // only the latest answer is shown, even if an older one arrives later
    setLoading(true); setError(null);
    api.report(key, range.from, range.to)
      .then((t) => { if (mine === seq.current) setTable(t); })
      .catch((e) => { if (mine === seq.current) { setTable(null); setError(e instanceof Error ? e.message : 'Could not load the report.'); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [api, allowed, key, range.from, range.to]);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => { printPage('Tiffin POS report'); if (onAndroid()) setTimeout(done, 60_000); }, 50); // let the print copy render first (Android: no afterprint event)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', done); };
  }, [printing]);

  const download = async () => {
    setDownloading(true);
    try {
      const { filename, csv } = await api.reportCsv(key, range.from, range.to);
      notify('success', await saveFile(filename, new Blob([csv], { type: 'text/csv;charset=utf-8' })));
    } catch (e) { fail(e); } finally { setDownloading(false); }
  };

  const info = catalog?.find((r) => r.key === key);
  const groups = [...new Set((catalog ?? []).map((r) => r.group))];
  const shown = table && table.key === key ? table : null;

  return (
    <PageShell route="reports" title="Reports" subtitle="Sales, tax, cash and stock reports. View them here, download for Excel, or print.">
      {!allowed ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Reports are for a manager or owner. Ask them to sign in.</p> : (
        <div className="flex flex-col gap-6 lg:flex-row">
          <nav className="shrink-0 lg:sticky lg:top-0 lg:max-h-[calc(100vh-3rem)] lg:w-60 lg:self-start lg:overflow-y-auto lg:pr-1" aria-label="Reports list">
            {catalog === null && <p className="text-sm text-muted-foreground">Loading…</p>}
            {groups.map((g) => {
              const Icon = GROUP_ICON[g] ?? BarChart3;
              return (
                <div key={g} className="mb-4">
                  <p className="mb-1.5 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="h-3.5 w-3.5" />{g}</p>
                  <div className="flex flex-wrap gap-1.5 lg:flex-col">
                    {catalog!.filter((r) => r.group === g).map((r) => (
                      <button key={r.key} onClick={() => setKey(r.key)} aria-current={key === r.key ? 'page' : undefined} title={r.description}
                        className={`rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors ${key === r.key ? 'border-primary bg-accent text-primary' : 'border-border bg-card hover:border-primary'}`}>
                        {r.title}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>

          <section className="min-w-0 flex-1" aria-label="Report">
            <div className="mb-4 flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-semibold">{info?.title ?? 'Report'}</h2>
                <p className="text-sm text-muted-foreground">{info?.description}</p>
              </div>
              <button className="btn-ghost" onClick={load} disabled={loading} aria-label="Refresh"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
              <button className="btn-ghost" onClick={() => setPrinting(true)} disabled={!shown}><Printer className="h-4 w-4" />Print / PDF</button>
              <button className="btn-primary" onClick={() => void download()} disabled={downloading || !shown}><Download className="h-4 w-4" />{downloading ? 'Downloading…' : 'Download CSV'}</button>
            </div>

            {info?.usesDates !== false ? (
              <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Dates">
                {PRESETS.map((p) => <button key={p.key} className={`chip ${preset === p.key ? 'chip-active' : ''}`} onClick={() => choose(p.key)}>{p.label}</button>)}
                <label className="ml-2 flex items-center gap-2 text-sm">From
                  <input type="date" className="field" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })); } }} />
                </label>
                <label className="flex items-center gap-2 text-sm">To
                  <input type="date" className="field" value={range.to} min={range.from} onChange={(e) => { if (e.target.value) { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })); } }} />
                </label>
              </div>
            ) : <p className="mb-4 text-sm text-muted-foreground">Shows stock as it is right now.</p>}

            {error && <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
            {!shown && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
            {shown && <ReportView t={shown} limit={SCREEN_ROWS} />}
          </section>
        </div>
      )}
      {printing && shown && createPortal(
        <div className="print-report">
          <h1 className="text-lg font-bold">{shown.title}</h1>
          <p className="mb-3 text-xs">{info?.usesDates === false ? 'As of' : `${formatDay(shown.from)} to ${formatDay(shown.to)} · printed`} {formatIstDateTime(shown.generatedAt)}</p>
          <ReportView t={shown} limit={Infinity} />
        </div>, document.body)}
    </PageShell>
  );
}

function ReportView({ t, limit }: { t: ReportTable; limit: number }) {
  const rows = t.rows.length > limit ? t.rows.slice(0, limit) : t.rows;
  const cell = (r: ReportRow, i: number, total = false) => {
    const c = t.columns[i]!;
    const v = r[c.key];
    if (total && (v === null || v === undefined)) return <td key={c.key} />;
    if (total && i === 0) return <td key={c.key} className="whitespace-nowrap px-3 py-2">{String(v)}</td>; // the "Total" label, whatever the column type
    const negative = c.type === 'money' && Number(v) < 0;
    return <td key={c.key} className={`whitespace-nowrap px-3 py-2 ${numeric(c.type) ? 'text-right tabular-nums' : ''} ${negative ? 'text-destructive' : ''}`}>{show(v, c.type)}</td>;
  };
  return (
    <>
      {t.summary.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Summary">
          {t.summary.map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{show(s.value, s.type)}</p>
            </div>
          ))}
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full bg-card text-sm">
          <thead className="bg-muted text-left">
            <tr>{t.columns.map((c) => <th key={c.key} scope="col" className={`whitespace-nowrap px-3 py-2.5 font-semibold ${numeric(c.type) ? 'text-right' : ''}`}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={t.columns.length} className="p-6 text-center text-muted-foreground">Nothing to show for these dates.</td></tr>}
            {rows.map((r, i) => <tr key={i} className="border-t border-border">{t.columns.map((_, j) => cell(r, j))}</tr>)}
          </tbody>
          {t.totals && rows.length > 0 && (
            <tfoot className="border-t-2 border-border bg-muted font-semibold">
              <tr>{t.columns.map((_, j) => cell(t.totals!, j, true))}</tr>
            </tfoot>
          )}
        </table>
      </div>
      {rows.length < t.rows.length && <p className="mt-2 text-sm text-muted-foreground">Showing the first {limit.toLocaleString('en-IN')} of {t.rows.length.toLocaleString('en-IN')} rows. The totals and the CSV download include every row.</p>}
    </>
  );
}
