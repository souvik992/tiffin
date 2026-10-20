import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, Boxes, ClipboardList, House, Settings as SettingsIcon, ShoppingCart, UtensilsCrossed, X } from 'lucide-react';
import type { ComponentType } from 'react';
import { useAddons } from '../lib/addons.ts';
import { useSession } from '../lib/session.tsx';
import { PIN_LENGTH } from '../lib/pin.ts';
import type { LoginUser } from '../lib/api.ts';

/** Core screens, or a screen an add-on registered (#/route). */
export type Route = string;

const NAV: Array<{ to: Route; label: string; icon: ComponentType<{ className?: string }> }> = [
  { to: 'billing', label: 'Billing', icon: House },
  { to: 'menu-items', label: 'Menu creation', icon: UtensilsCrossed },
  { to: 'stock', label: 'Stock', icon: Boxes },
  { to: 'purchases', label: 'Purchase', icon: ShoppingCart },
  { to: 'orders', label: 'Orders', icon: ClipboardList },
  { to: 'reports', label: 'Reports', icon: BarChart3 },
  { to: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function Rail({ route }: { route: Route }) {
  const { addons } = useAddons();
  const extra = addons.flatMap((a) => (a.nav ?? []).filter((n) => !n.visible || n.visible()).map((n) => ({ to: n.route, label: n.label, icon: n.icon })));
  const items = [...NAV.slice(0, -2), ...extra, ...NAV.slice(-2)]; // add-on screens before Reports and Settings
  return (
    <nav className="relative z-30 flex w-16 shrink-0 flex-col items-center gap-2 border-r border-border bg-card py-4" aria-label="Main">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary font-display text-lg text-primary-foreground">T</div>
      {items.map(({ to, label, icon: Icon }) => (
        <a key={to} href={`#/${to === 'billing' ? '' : to}`} aria-label={label}
          aria-current={route === to ? 'page' : undefined} className={`rail-btn group relative ${route === to ? 'rail-btn-active' : ''}`}>
          <Icon className="h-5 w-5" />
          {/* Tooltip to the right, on hover and on keyboard focus (the link's aria-label already names it for screen readers). */}
          <span aria-hidden className="rail-tip">{label}</span>
        </a>
      ))}
      <div className="mt-auto flex flex-col items-center gap-2">{addons.map((a) => (a.railFooter ? <a.railFooter key={a.id} /> : null))}</div>
    </nav>
  );
}

export function PageShell({ route, title, subtitle, children }: { route: Route; title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Rail route={route} />
      <main className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
        <h1 className="font-display text-3xl">{title}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{subtitle}</p>
        {children}
      </main>
    </div>
  );
}

export function VegMark({ veg }: { veg: number | boolean | null }) {
  if (veg === null) return null;
  const isVeg = Boolean(veg);
  return (
    <span className={`veg-mark ${isVeg ? 'border-veg' : 'border-nonveg'}`} role="img" aria-label={isVeg ? 'Veg' : 'Non-veg'}>
      <span className={`h-1.5 w-1.5 rounded-full ${isVeg ? 'bg-veg' : 'bg-nonveg'}`} />
    </span>
  );
}

export function Modal({ title, onClose, children, width = 'max-w-md' }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-2 sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      {/* never taller than the screen: the title and the close button stay in view, the content scrolls */}
      <div className={`flex max-h-[calc(100dvh-1rem)] w-full ${width} flex-col rounded-2xl border border-border bg-card shadow-xl sm:max-h-[calc(100dvh-2rem)]`}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="min-w-0 truncate font-display text-xl font-semibold">{title}</h2>
          <button className="rail-btn h-10 w-10 shrink-0" onClick={onClose} aria-label="Close" title="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
      </div>
    </div>
  );
}

/** PIN entry with an on-screen keypad (touch counters) that also accepts the keyboard. */
export function PinPad({ onSubmit, busy, label = 'Enter PIN' }: { onSubmit: (pin: string) => void; busy?: boolean; label?: string }) {
  const [pin, setPin] = useState('');
  const press = (d: string) => setPin((p) => (p.length < PIN_LENGTH ? p + d : p));
  const submit = () => { if (pin.length === PIN_LENGTH && !busy) { onSubmit(pin); setPin(''); } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return; // typing in a field is not PIN entry
      // The number keypad sends arrows and Page keys when Num Lock is off; read it by key position instead.
      const digit = /^\d$/.test(e.key) ? e.key : /^Numpad\d$/.test(e.code) ? e.code.slice(6) : null;
      if (digit) { e.preventDefault(); press(digit); }
      else if (e.key === 'Backspace' || e.code === 'NumpadDecimal') { e.preventDefault(); setPin((p) => p.slice(0, -1)); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); } // also stops Enter from pressing a focused keypad button
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="mx-auto w-full max-w-xs">
      <p className="mb-2 text-center text-sm text-muted-foreground">{label}</p>
      <div className="mb-4 flex justify-center gap-3" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={`h-3.5 w-3.5 rounded-full border border-primary ${i < pin.length ? 'bg-primary' : ''}`} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className="qty-btn h-14 w-full text-xl" onClick={() => press(d)}>{d}</button>
        ))}
        <button type="button" className="qty-btn h-14 w-full text-sm" onClick={() => setPin('')}>Clear</button>
        <button type="button" className="qty-btn h-14 w-full text-xl" onClick={() => press('0')}>0</button>
        <button type="button" className="h-14 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground" disabled={pin.length !== PIN_LENGTH || busy} onClick={submit}>
          {busy ? '…' : 'OK'}
        </button>
      </div>
    </div>
  );
}

/** Manager/owner approval. Opened by withApproval() when the backend answers APPROVAL_REQUIRED. */
export function ApprovalDialog() {
  const { approval, api } = useSession();
  const [approvers, setApprovers] = useState<LoginUser[]>([]);
  const [who, setWho] = useState<string>('');
  useEffect(() => {
    if (!approval) return;
    api.loginUsers().then((u) => {
      const list = u.filter((x) => x.role !== 'cashier');
      setApprovers(list);
      setWho((w) => w || list[0]?.id || '');
    }).catch(() => setApprovers([]));
  }, [approval, api]);
  if (!approval) return null;
  return (
    <Modal title="Manager approval" onClose={() => approval.resolve(null)}>
      <p className="mb-4 text-sm text-muted-foreground">{approval.reason} needs a manager or owner.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {approvers.map((u) => (
          <button key={u.id} type="button" className={`chip ${who === u.id ? 'chip-active' : ''}`} onClick={() => setWho(u.id)}>{u.name}</button>
        ))}
      </div>
      <PinPad label="Approver's PIN" onSubmit={(pin) => who && approval.resolve({ userId: who, pin })} />
    </Modal>
  );
}

export function Notices() {
  const { notices, dismiss } = useSession();
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-lg -translate-x-1/2 flex-col gap-2 px-4" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} role={n.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${n.kind === 'error' ? 'border-destructive/30 bg-card text-destructive' : n.kind === 'success' ? 'border-success/30 bg-card text-foreground' : 'border-border bg-card'}`}>
          <span className="flex-1">{n.text}</span>
          <button onClick={() => dismiss(n.id)} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  );
}
