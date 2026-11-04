import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReportTable } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { PageShell } from '../components/ui.tsx';
import { PRESETS, formatDay, presetRange } from '../lib/dates.ts';
import type { Preset } from '../lib/dates.ts';
import { formatPaise } from '../lib/money.ts';
import { ColumnChart, RankList } from './charts.tsx';

const KEYS = ['sales-summary', 'hourly', 'items', 'categories', 'payments', 'channels'] as const;
type Key = (typeof KEYS)[number];
const DAY = 86_400_000;

/** Every day of the range, so days without sales show as gaps rather than disappearing. */
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end && out.length < 400; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const num = (v: unknown) => Number(v ?? 0);

function Card({ title, sub, children, wide }: { title: string; sub?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`rounded-2xl border border-border bg-card p-5 ${wide ? 'lg:col-span-2' : ''}`}>
      <h2 className="font-semibold">{title}</h2>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Dashboard() {
  const { api } = useSession();
  const [preset, setPreset] = useState<Preset | 'custom'>('last7');
  const [range, setRange] = useState(() => presetRange('last7'));
  const [data, setData] = useState<Partial<Record<Key, ReportTable>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setError(null);
    Promise.all(KEYS.map((k) => api.report(k, range.from, range.to).then((t) => [k, t] as const)))
      .then((r) => { if (mine === seq.current) setData(Object.fromEntries(r)); })
      .catch((e: unknown) => { if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load the numbers.'); });
  }, [api, range]);

  const summary = data?.['sales-summary'];
  const byDay = new Map((summary?.rows ?? []).map((r) => [String(r.day), num(r.netSales)]));
  const days = daysOf(range.from, range.to);
  const hourly = data?.hourly?.rows ?? [];
  const hours = hourly.map((r) => Number(String(r.hour).slice(0, 2))).filter((h) => !Number.isNaN(h));
  const byHour = new Map(hourly.map((r) => [Number(String(r.hour).slice(0, 2)), num(r.netSales)]));
  const hourSpan = hours.length ? Array.from({ length: Math.max(...hours) - Math.min(...hours) + 1 }, (_, i) => Math.min(...hours) + i) : [];
  const hourText = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;

  return (
    <PageShell route="dashboard" title="Dashboard" subtitle="Your shop's sales at a glance. Exact tables are under Reports.">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.key} className={`chip ${preset === p.key ? 'chip-active' : ''}`} onClick={() => { setPreset(p.key); setRange(presetRange(p.key)); }}>{p.label}</button>
        ))}
        <span className="ml-2 flex items-center gap-1 text-sm">
          <input type="date" aria-label="From" className="field h-9 w-40" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })); } }} />
          <span className="text-muted-foreground">to</span>
          <input type="date" aria-label="To" className="field h-9 w-40" value={range.to} min={range.from} onChange={(e) => { if (e.target.value) { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })); } }} />
        </span>
      </div>

      {error && <p className="mb-4 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="text-muted-foreground">Loading…</p>}

      {data && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {(summary?.summary ?? []).map((s) => (
              <div key={s.label} className="rounded-2xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="mt-1 font-display text-2xl tabular-nums">{s.type === 'money' ? formatPaise(Number(s.value)) : Number(s.value).toLocaleString('en-IN')}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card wide title="Net sales by day" sub={`${formatDay(range.from)} to ${formatDay(range.to)}. Hover a bar for the exact amount.`}>
              <ColumnChart bars={days.map((d) => ({ label: d.slice(8), tip: formatDay(d), value: byDay.get(d) ?? 0 }))} labelEvery={Math.ceil(days.length / 16)} />
            </Card>
            <Card title="Busy hours" sub="Net sales per hour of the day">
              {hourSpan.length ? <ColumnChart height={200} bars={hourSpan.map((h) => ({ label: hourText(h), tip: `${hourText(h)} to ${hourText((h + 1) % 24)}`, value: byHour.get(h) ?? 0 }))} labelEvery={Math.ceil(hourSpan.length / 8)} />
                : <p className="py-6 text-center text-sm text-muted-foreground">No sales in this period.</p>}
            </Card>
            <Card title="Payment modes" sub="Received, less refunds">
              <RankList empty="No payments in this period." rows={(data.payments?.rows ?? []).map((r) => ({ label: String(r.mode), value: num(r.net), note: `${num(r.count).toLocaleString('en-IN')} payments` }))} />
            </Card>
            <Card title="Best sellers" sub="Top 10 items by net sales">
              <RankList empty="No items sold in this period." rows={(data.items?.rows ?? []).slice(0, 10).map((r) => ({ label: String(r.item), value: num(r.netSales), note: String(r.category ?? '') }))} />
            </Card>
            <Card title="Categories" sub="Net sales per menu category">
              <RankList empty="No sales in this period." rows={(data.categories?.rows ?? []).map((r) => ({ label: String(r.category), value: num(r.netSales) }))} />
            </Card>
            <Card title="Order channels" sub="Counter, online and delivery apps">
              <RankList empty="No bills in this period." rows={(data.channels?.rows ?? []).map((r) => ({ label: String(r.channel), value: num(r.netSales), note: `${num(r.bills).toLocaleString('en-IN')} bills` }))} />
            </Card>
          </div>
        </>
      )}
    </PageShell>
  );
}
