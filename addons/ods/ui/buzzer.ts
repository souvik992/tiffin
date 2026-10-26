// The online-order buzzer: rings on every screen (not only the ODS) while an order waits to be accepted, like an order
// tablet. In the automatic accept mode an order never waits, so a new one rings twice and shows a banner for a while. One live feed for the whole app, started by the side-menu status dot (index.tsx). Sound on/off is shared
// with the ODS screen's switch (localStorage "ods.sound").
import { useSyncExternalStore } from 'react';
import { BASE, host } from './host.ts';
import { arrivals, isWaiting } from './arrivals.ts';
import type { FeedOrder } from './arrivals.ts';

export interface WaitingOrder { id: string; number: string }
interface Snapshot {
  waiting: WaitingOrder[]; silenced: boolean; soundOn: boolean; /** Connected to the order hub (null until the feed answers). */ connected: boolean | null;
  /** New orders accepted automatically just now (shown for RECENT_MS). */
  recent: string[];
}

const RING_EVERY_MS = 3000;
const RECENT_MS = 20_000;
let started = false;
let waiting: WaitingOrder[] = [];
let known = new Set<string>();
const silencedIds = new Set<string>();
let connected: boolean | null = null;
let seen: Set<string> | null = null; // every order on the feed at the last update (null: none yet)
let recent: string[] = [];
let recentTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: Snapshot = { waiting: [], silenced: false, soundOn: true, connected: null, recent: [] };
const subs = new Set<() => void>();
let ctx: AudioContext | null = null;

export const soundOn = (): boolean => { try { return localStorage.getItem('ods.sound') !== 'off'; } catch { return true; } };
const loud = () => waiting.some((w) => !silencedIds.has(w.id));
function emit() {
  snapshot = { waiting, silenced: waiting.length > 0 && !loud(), soundOn: soundOn(), connected, recent };
  subs.forEach((f) => f());
}

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}
// Browsers may hold sound back until the first tap: any tap on the POS unlocks it.
if (typeof document !== 'undefined') document.addEventListener('pointerdown', () => { if (ctx?.state === 'suspended') void ctx.resume(); }, { capture: true });

/** One ring: three loud two-tone pulses (about a second). */
export function ringOnce(): void {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + 0.02;
  for (let i = 0; i < 3; i++) {
    for (const [freq, at] of [[988, 0], [1319, 0.13]] as const) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      const s = t0 + i * 0.36 + at;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.35, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.12);
      o.connect(g); g.connect(a.destination);
      o.start(s); o.stop(s + 0.13);
    }
  }
}

function tick() { if (loud() && soundOn()) ringOnce(); }

/** Starts the live feed once for the whole app (safe to call on every render). */
export function startBuzzer(): void {
  if (started || !host.stream) return;
  started = true;
  host.stream(`${BASE}/events`, (type, data) => {
    if (type !== 'ods') return;
    connected = (data as { link?: { state?: string } }).link?.state === 'connected';
    const orders = (data as { orders?: FeedOrder[] }).orders ?? [];
    waiting = orders.filter(isWaiting).map((o) => ({ id: o.id, number: o.number }));
    const news = arrivals(seen, orders);
    seen = news.ids;
    if (news.autoAccepted.length) {
      // accepted automatically: ring twice and show it for a while (nothing for staff to do but make it)
      recent = [...recent, ...news.autoAccepted.map((o) => o.number)].slice(-5);
      if (recentTimer) clearTimeout(recentTimer);
      recentTimer = setTimeout(() => { recent = []; emit(); }, RECENT_MS);
      if (soundOn()) { ringOnce(); setTimeout(ringOnce, 1300); }
    }
    const ids = new Set(waiting.map((w) => w.id));
    for (const id of [...silencedIds]) if (!ids.has(id)) silencedIds.delete(id);
    const arrived = waiting.some((w) => !known.has(w.id));
    known = ids;
    emit();
    if (arrived) tick(); // ring at once, then every few seconds
  }, (live) => { if (!live) { connected = false; emit(); } }); // the feed itself dropped: not connected
  setInterval(tick, RING_EVERY_MS);
}

/** Stops the ringing for the orders waiting now; a new order rings again. */
export function silence(): void { waiting.forEach((w) => silencedIds.add(w.id)); emit(); }

/** Hides the "accepted automatically" banner. */
export function dismissRecent(): void { recent = []; if (recentTimer) clearTimeout(recentTimer); emit(); }

export function setSoundOn(on: boolean): void {
  try { localStorage.setItem('ods.sound', on ? 'on' : 'off'); } catch { /* ignore */ }
  emit();
  if (on) ringOnce();
}

export function useBuzzer(): Snapshot {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snapshot, () => snapshot);
}
