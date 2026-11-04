import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { formatPaise } from '../lib/money.ts';

// Small single-series charts for the dashboard. Every value arrives from the backend in paise; the charts only scale
// bars and format labels. One hue (the brand orange): one series needs no legend, the title names it.

/** Axis labels only: 1,20,000 paise -> "₹1.2k". Exact amounts are in the tooltip and the Reports tables. */
export function shortRupees(paise: number): string {
  const r = paise / 100;
  const a = Math.abs(r);
  if (a >= 1e7) return `₹${(r / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`;
  if (a >= 1e5) return `₹${(r / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e3) return `₹${(r / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `₹${Math.round(r)}`;
}

/** A round top for the axis (1, 2, 2.5 or 5 times a power of ten). */
function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export interface Bar { label: string; tip: string; value: number }

/** The element's width in pixels, so the chart is drawn at its real size (text never scales with the screen). */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Vertical bars along a time axis (days, hours), with a hover tooltip per bar. */
export function ColumnChart({ bars, height = 220, labelEvery = 1 }: { bars: Bar[]; height?: number; labelEvery?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const H = height, L = 56, B = 26, T = 10;
  const top = niceMax(Math.max(0, ...bars.map((b) => b.value)));
  const plotW = W - L - 8, plotH = H - B - T;
  const slot = plotW / Math.max(bars.length, 1);
  const barW = Math.max(2, Math.min(36, slot - 2)); // 2px surface gap between neighbours
  const y = (v: number) => T + plotH - (Math.max(v, 0) / top) * plotH;
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const h = hover === null ? null : bars[hover];
  return (
    <div className="relative" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Bar chart" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted-foreground)">{shortRupees(t)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = L + i * slot + (slot - barW) / 2, top0 = y(b.value), hgt = T + plotH - top0;
          const r = Math.min(4, barW / 2, hgt);
          return (
            <g key={i}>
              {hgt > 0 && <path d={`M${x},${T + plotH} V${top0 + r} Q${x},${top0} ${x + r},${top0} H${x + barW - r} Q${x + barW},${top0} ${x + barW},${top0 + r} V${T + plotH} Z`}
                fill="var(--primary)" opacity={hover === null || hover === i ? 1 : 0.45} />}
              {i % labelEvery === 0 && <text x={L + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{b.label}</text>}
              <rect x={L + i * slot} y={T} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-md"
          style={{ left: Math.min(W - 160, Math.max(0, L + hover * slot + slot / 2 - 60)) }}>
          <p className="font-semibold">{h.tip}</p>
          <p className="text-muted-foreground">{formatPaise(h.value)}</p>
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars with the name and amount written next to each (no colour-only reading). */
export function RankList({ rows, empty }: { rows: Array<{ label: string; value: number; note?: string }>; empty: string }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${formatPaise(r.value)}${r.note ? ` (${r.note})` : ''}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{r.label}{r.note && <span className="ml-1.5 text-xs text-muted-foreground">{r.note}</span>}</span>
            <span className="shrink-0 font-semibold tabular-nums">{formatPaise(r.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(1, (Math.max(r.value, 0) / top) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
