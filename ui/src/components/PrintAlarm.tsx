// The print alarm: on every screen, a red banner and a repeating alarm sound as soon as a bill or kitchen ticket fails
// to print (after the print queue's retries), until staff retry it or dismiss it. Without it a failed kitchen ticket
// only showed as a small number on the Billing bell, and the kitchen never got the order.
// Live through the events stream (print FAILED / PRINTED), with a poll as a fallback when the stream is down.
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, TriangleAlert, X } from 'lucide-react';
import { useSession } from '../lib/session.tsx';
import type { PrintJob } from '../lib/api.ts';
import { alarmJobs, describeJob, pruneDismissed } from '../lib/printAlarm.ts';
import { posHost } from '../addonHost.ts';

const POLL_MS = 10_000;
const RING_EVERY_MS = 4000;

let ctx: AudioContext | null = null;
/** Two low-high-low pulses: different from the online-order buzzer, so staff can tell a printer problem apart. */
function ringAlarm(): void {
  try {
    if (!ctx) ctx = new window.AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    [523, 1047, 523, 1047].forEach((freq, i) => {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      const s = t0 + i * 0.22;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.3, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
      o.connect(g); g.connect(ctx!.destination);
      o.start(s); o.stop(s + 0.21);
    });
  } catch { /* no sound device: the banner still shows */ }
}

export function PrintAlarm() {
  const { api } = useSession();
  const [failed, setFailed] = useState<PrintJob[]>([]);
  const [busy, setBusy] = useState(false);
  const dismissed = useRef(new Set<string>());
  const [, rerender] = useState(0);

  const refresh = useCallback(() => {
    api.failedPrintJobs().then((r) => { pruneDismissed(dismissed.current, r.jobs); setFailed(r.jobs); }).catch(() => { /* not allowed or offline: nothing to show */ });
  }, [api]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    const stop = posHost.stream('/events', (type, data) => {
      const status = (data as { status?: string } | null)?.status;
      if (type === 'print' && (status === 'FAILED' || status === 'PRINTED')) refresh();
    });
    return () => { clearInterval(t); stop(); };
  }, [refresh]);

  const ringing = alarmJobs(failed, Date.now(), dismissed.current);
  const loud = ringing.length > 0;
  useEffect(() => {
    if (!loud) return;
    ringAlarm();
    const t = setInterval(ringAlarm, RING_EVERY_MS);
    return () => clearInterval(t);
  }, [loud]);

  if (!loud) return null;
  const first = ringing[0]!;
  const retryAll = async () => {
    setBusy(true);
    try { await Promise.all(ringing.map((j) => api.retryPrintJob(j.id).catch(() => undefined))); } finally { setBusy(false); refresh(); }
  };
  const dismiss = () => { ringing.forEach((j) => dismissed.current.add(j.id)); rerender((n) => n + 1); };

  return (
    <div role="alert" aria-label="Printing failed" className="fixed bottom-4 left-1/2 z-[2100] flex w-[min(94vw,620px)] -translate-x-1/2 items-center gap-3 rounded-2xl border-2 border-destructive bg-card p-3 shadow-2xl">
      <span className="flex h-11 w-11 shrink-0 animate-pulse items-center justify-center rounded-full bg-destructive text-white"><TriangleAlert className="h-6 w-6" /></span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{describeJob(first)}{ringing.length > 1 ? ` (+${ringing.length - 1} more)` : ''}</p>
        <p className="truncate text-xs text-muted-foreground" title={first.lastError ?? ''}>Check the printer is on, has paper and is connected, then retry. {first.lastError ?? ''}</p>
      </div>
      <button className="btn-primary h-10 shrink-0 px-4" disabled={busy} onClick={() => void retryAll()}><RotateCw className="h-4 w-4" />Retry</button>
      <button className="btn-ghost h-10 shrink-0 px-3" onClick={dismiss} aria-label="Dismiss the print alarm"><X className="h-4 w-4" /></button>
    </div>
  );
}
