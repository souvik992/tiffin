import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { CheckCircle2, Clock, Printer, RotateCw, TriangleAlert } from 'lucide-react';
import type { InvoicePrintJob, ReceiptPreview } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Modal } from './ui.tsx';
import { printPage } from '../lib/android.ts';

/**
 * The receipt exactly as the thermal printer prints it (rendered by the backend from the same ESC/POS bytes),
 * with a browser print button: works with any Windows printer, PDF, or a thermal printer driver when no
 * ESC/POS connection is set up. Only the receipt is printed (see the print styles in styles.css).
 */
export function ReceiptDialog({ invoiceId, title, onClose }: { invoiceId: string; title: string; onClose: () => void }) {
  const { api, fail } = useSession();
  const [width, setWidth] = useState<58 | 80>(80);
  const [rc, setRc] = useState<ReceiptPreview | null>(null);
  // onClose is often a new function on every parent render; keep it out of the effect so the receipt is not refetched.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => { setRc(null); api.receiptPreview(invoiceId, width).then(setRc).catch((e) => { fail(e); closeRef.current(); }); }, [api, fail, invoiceId, width]);
  // Fit the column count to the paper: printable width is about 72 mm (80 mm paper) or 48 mm (58 mm paper).
  const printable = width === 80 ? 72 : 48;
  const fontMm = rc ? printable / rc.cols / 0.6 : 3;
  return (
    <Modal title={title} onClose={onClose} width="max-w-md">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Paper</span>
        {([80, 58] as const).map((w) => <button key={w} className={`chip ${width === w ? 'chip-active' : ''}`} onClick={() => setWidth(w)}>{w} mm</button>)}
        <button className="btn-primary ml-auto" disabled={!rc} onClick={() => printPage(title)}><Printer className="h-4 w-4" />Print</button>
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-white p-3">
        {!rc ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <ReceiptLines lines={rc.lines} logoUrl={api.logoUrl()} className="print-receipt mx-auto" style={{ fontSize: `${fontMm}mm`, width: `${printable}mm` }} paper={width} />
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Prints through Windows to any printer. Choose your receipt printer, or "Save as PDF".</p>
    </Modal>
  );
}

/**
 * Receipt text lines as the printer prints them. A "[LOGO]" line (the backend's marker for the bill logo) shows the logo
 * at its printed size: the printer's font is 12 dots wide, so a logo of W dots is W / 12 characters wide.
 */
export function ReceiptLines({ lines, logoUrl, className = '', style, paper }: { lines: string[]; logoUrl: string; className?: string; style?: CSSProperties; paper?: number }) {
  const parts: Array<string[] | 'logo'> = [];
  for (const l of lines) {
    const last = parts.at(-1);
    if (l === '[LOGO]') parts.push('logo');
    else if (Array.isArray(last)) last.push(l);
    else parts.push([l]);
  }
  return (
    <div className={`font-mono leading-tight text-black ${className}`} style={style} data-paper={paper} aria-label="Receipt preview" role="document">
      {parts.map((p, i) => p === 'logo'
        ? <img key={i} src={logoUrl} alt="Logo" className="mx-auto my-1 block" style={{ imageRendering: 'pixelated' }} onLoad={(e) => { e.currentTarget.style.width = `${e.currentTarget.naturalWidth / 12}ch`; }} />
        : <pre key={i} className="m-0 whitespace-pre font-mono leading-tight">{p.join('\n')}</pre>)}
    </div>
  );
}

const DONE = new Set(['PRINTED', 'FAILED']);

/** Live status of a bill's print jobs (receipt and kitchen tickets), polled until each is printed or failed. */
export function PrintStatus({ invoiceId, onRetry }: { invoiceId: string; onRetry?: (jobId: string) => void }) {
  const { api } = useSession();
  const [jobs, setJobs] = useState<InvoicePrintJob[] | null>(null);
  useEffect(() => {
    let stop = false, tries = 0;
    const tick = async () => {
      try {
        const j = await api.invoicePrints(invoiceId);
        if (stop) return;
        setJobs(j);
        if (j.every((x) => DONE.has(x.status)) || ++tries > 40) return;
      } catch { if (++tries > 40) return; }
      if (!stop) setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => { stop = true; };
  }, [api, invoiceId]);
  if (!jobs) return <p className="text-xs text-muted-foreground">Checking printers…</p>;
  if (jobs.length === 0) return <p className="flex items-center gap-1.5 text-xs text-destructive"><TriangleAlert className="h-3.5 w-3.5" />Nothing was sent to a printer.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {jobs.map((j) => (
        <li key={j.id} className="flex items-center gap-1.5">
          {j.status === 'PRINTED' ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : j.status === 'FAILED' ? <TriangleAlert className="h-3.5 w-3.5 text-destructive" /> : <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">
            {j.kind === 'KOT' ? 'Kitchen ticket' : j.kind === 'RECEIPT' ? 'Receipt' : j.kind.toLowerCase()} on {j.printerName}:{' '}
            <span className={j.status === 'FAILED' ? 'text-destructive' : 'text-muted-foreground'} title={j.lastError ?? ''}>
              {j.status === 'PRINTED' ? 'printed' : j.status === 'FAILED' ? (j.lastError ?? 'failed') : j.attempts > 0 ? `retrying (${j.lastError ?? 'printer busy'})` : 'sending…'}
            </span>
          </span>
          {j.status === 'FAILED' && onRetry && <button className="shrink-0 text-primary" aria-label="Retry printing" onClick={() => onRetry(j.id)}><RotateCw className="h-3.5 w-3.5" /></button>}
        </li>
      ))}
    </ul>
  );
}
