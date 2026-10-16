import { useCallback, useEffect, useRef, useState } from 'react';
import { Usb, X } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { DetectedPrinter } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';

/**
 * Plug and play: when a USB printer is plugged in, offer to use it for bills in one tap.
 * The backend scans at most every 15 s and only while someone is looking; this polls every 10 s.
 */
export function PlugAndPlay({ compact = false, onAdded }: { compact?: boolean; onAdded?: () => void }) {
  const { api, notify, fail, withApproval } = useSession();
  const [found, setFound] = useState<DetectedPrinter[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const refresh = useCallback(() => { api.detectedPrinters().then(setFound).catch(() => { /* optional feature */ }); }, [api]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 10_000); return () => clearInterval(t); }, [refresh]);

  const use = async (d: DetectedPrinter) => {
    if (!keys.current.has(d.key)) keys.current.set(d.key, newKey());
    setBusy(d.key);
    try {
      const r = await withApproval('Setting up a printer', (o) => api.quickAddPrinter(d.key, o, keys.current.get(d.key)));
      if (r) {
        keys.current.delete(d.key);
        notify('success', r.isReceipt ? `${r.name} is now the receipt printer. A test page is printing.` : `${r.name} is set up. A test page is printing. Choose what it prints in Settings, Printers.`);
        onAdded?.();
      }
    } catch (e) { keys.current.delete(d.key); fail(e); } finally { setBusy(null); refresh(); }
  };
  const later = async (d: DetectedPrinter) => { try { await api.dismissDetected(d.key); } catch (e) { fail(e); } finally { refresh(); } };

  if (found.length === 0) return null;
  return (
    <div className={compact ? 'space-y-2 px-4 pb-1' : 'mb-4 space-y-2'} aria-live="polite">
      {found.map((d) => (
        <div key={d.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-accent px-4 py-2.5 text-sm">
          <Usb className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">USB printer connected: {d.name}</p>
            <p className="truncate text-xs text-muted-foreground">{d.detail} · {d.widthMm} mm paper</p>
          </div>
          <button className="btn-primary h-9" disabled={busy !== null} onClick={() => void use(d)}>{busy === d.key ? 'Setting up…' : 'Use for bills'}</button>
          <button className="rail-btn h-9 w-9" aria-label={`Not now: ${d.name}`} title="Not now" onClick={() => void later(d)}><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  );
}
