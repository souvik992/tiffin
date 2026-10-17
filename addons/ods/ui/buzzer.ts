// The online-order buzzer: rings on every screen (not only the ODS) while an order waits to be accepted, like an order
// tablet. One live feed for the whole app, started by the side-menu status dot (index.tsx). Sound on/off is shared
// with the ODS screen's switch (localStorage "ods.sound").
import { useSyncExternalStore } from 'react';
import { BASE, host } from './host.ts';

export interface WaitingOrder { id: string; number: string }
interface Snapshot { waiting: WaitingOrder[]; silenced: boolean; soundOn: boolean; /** Connected to the order hub (null until the feed answers). */ connected: boolean | null }

const RING_EVERY_MS = 3000;
let started = false;
let waiting: WaitingOrder[] = [];
let known = new Set<string>();
const silencedIds = new Set<string>();
let connected: boolean | null = null;
let snapshot: Snapshot = { waiting: [], silenced: false, soundOn: true, connected: null };
const subs = new Set<() => void>();
let ctx: AudioContext | null = null;

export const soundOn = (): boolean => { try { return localStorage.getItem('ods.sound') !== 'off'; } catch { return true; } };
const loud = () => waiting.some((w) => !silencedIds.has(w.id));
function emit() {
  snapshot = { waiting, silenced: waiting.length > 0 && !loud(), soundOn: soundOn(), connected };
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
    const orders = (data as { orders?: Array<{ id: string; number: string; state: string; billInvoiceId: string | null }> }).orders ?? [];
    waiting = orders.filter((o) => (o.state === 'SENT_TO_STORE' || o.state === 'RECEIVED') && !o.billInvoiceId).map((o) => ({ id: o.id, number: o.number }));
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

export function setSoundOn(on: boolean): void {
  try { localStorage.setItem('ods.sound', on ? 'on' : 'off'); } catch { /* ignore */ }
  emit();
  if (on) ringOnce();
}

export function useBuzzer(): Snapshot {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => snapshot, () => snapshot);
}
