import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Search, Table2 } from 'lucide-react';
import { PageShell } from '../components/ui.tsx';
import { useSession } from '../lib/session.tsx';
import { saveFile } from '../lib/android.ts';
import { mgr } from './mgr.ts';
import type { TableInfo, TablePage } from './mgr.ts';

const PAGE = 50;

/** Plain names for the tables people look at most; the rest keep their database names. */
const NAMES: Record<string, string> = {
  invoice: 'Bills', invoice_line: 'Bill lines', payment: 'Payments', payment_effective: 'Payments (after corrections)',
  item: 'Menu items', category: 'Categories', app_user: 'Staff', audit_log: 'Activity log', sale_order: 'Orders', sale_order_line: 'Order lines',
  shift: 'Shifts', stock_item: 'Stock materials', stock_movement: 'Stock movements', purchase: 'Purchases', purchase_line: 'Purchase lines',
  outlet: 'Store', outlet_version: 'Store details history', settings: 'Settings', customer: 'Customers', coupon: 'Coupons',
  prep_station: 'Prep stations', kot_line: 'Kitchen tickets', print_job: 'Print jobs', daily_summary: 'Daily totals',
};
const nice = (t: string) => NAMES[t] ?? t.replace(/_/g, ' ');
/** Columns stored as epoch milliseconds are shown as Indian dates (the cell's title keeps the stored value). */
const isTime = (c: string) => /(_at|^at|_until|^ts)$/.test(c);
const showCell = (c: string, v: string | number | null) => {
  if (v === null) return '';
  if (typeof v === 'number' && isTime(c) && v > 1e11) return new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return String(v);
};

export function AllData() {
  const { fail, notify } = useSession();
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [name, setName] = useState('invoice');
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<TablePage | null>(null);
  const seq = useRef(0);

  useEffect(() => { mgr.tables().then(setTables).catch(fail); }, [fail]);
  useEffect(() => {
    const mine = ++seq.current;
    mgr.table(name, q, offset, PAGE).then((p) => { if (mine === seq.current) setPage(p); }).catch(fail);
  }, [name, q, offset, fail]);
  useEffect(() => { const t = setTimeout(() => { setQ(typed); setOffset(0); }, 300); return () => clearTimeout(t); }, [typed]);

  const pick = (n: string) => { setName(n); setTyped(''); setQ(''); setOffset(0); setPage(null); };
  const download = async () => {
    try { notify('success', await saveFile(`${name}.csv`, new Blob([await mgr.tableCsv(name, q)], { type: 'text/csv;charset=utf-8' }))); } catch (e) { fail(e); }
  };
  const shown = (tables ?? []).filter((t) => !filter || `${t.name} ${nice(t.name)}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <PageShell route="data" title="All data" subtitle="Every table in the POS database, exactly as stored. Amounts are in paise (100 = ₹1). PINs, sign-ins and keys are hidden.">
      <div className="flex min-h-0 gap-4">
        <aside className="w-60 shrink-0">
          <input className="field mb-2 w-full" placeholder="Find a table" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-1 text-sm">
            {shown.map((t) => (
              <li key={t.name}>
                <button className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left ${t.name === name ? 'bg-accent text-primary' : 'hover:bg-secondary'}`} onClick={() => pick(t.name)} title={t.name}>
                  <span className="truncate">{nice(t.name)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t.rows.toLocaleString('en-IN')}</span>
                </button>
              </li>
            ))}
            {tables && !shown.length && <li className="px-2.5 py-2 text-muted-foreground">No table matches.</li>}
          </ul>
        </aside>
        <section className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="mr-auto flex items-center gap-2 font-semibold"><Table2 className="h-4 w-4 text-primary" />{nice(name)} <span className="text-xs font-normal text-muted-foreground">{name}</span></h2>
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-muted-foreground" />
              <input className="field w-64 pl-8" placeholder="Search in this table" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
            <button className="btn-ghost" onClick={() => void download()}><Download className="h-4 w-4" />Download CSV</button>
          </div>
          {!page ? <p className="text-muted-foreground">Loading…</p> : (
            <>
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-xs">
                  <thead className="bg-secondary text-left">
                    <tr>{page.columns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-semibold">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {page.rows.map((r, i) => (
                      <tr key={i} className="border-t border-border align-top">
                        {r.map((v, j) => <td key={j} className={`max-w-[22rem] truncate whitespace-nowrap px-3 py-1.5 ${v === null ? 'text-muted-foreground' : ''} ${typeof v === 'number' ? 'text-right tabular-nums' : ''}`} title={v === null ? 'empty' : String(v)}>{showCell(page.columns[j]!, v)}</td>)}
                      </tr>
                    ))}
                    {!page.rows.length && <tr><td className="px-3 py-6 text-center text-muted-foreground" colSpan={page.columns.length || 1}>{q ? 'Nothing matches the search.' : 'This table is empty.'}</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className="mr-auto text-muted-foreground">
                  {page.total ? `${(page.offset + 1).toLocaleString('en-IN')}–${Math.min(page.offset + page.rows.length, page.total).toLocaleString('en-IN')} of ${page.total.toLocaleString('en-IN')} rows, newest first` : '0 rows'}
                </span>
                <button className="btn-ghost h-9" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}><ChevronLeft className="h-4 w-4" />Newer</button>
                <button className="btn-ghost h-9" disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>Older<ChevronRight className="h-4 w-4" /></button>
              </div>
            </>
          )}
        </section>
      </div>
    </PageShell>
  );
}
