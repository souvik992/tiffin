import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  Banknote, Bluetooth, DatabaseBackup, CheckCircle2, CircleAlert, FileText, Monitor, Pencil, Plus, Power, Printer as PrinterIcon, ReceiptText, RefreshCw, RotateCw, Search, Smartphone, Store, Ticket, Trash2, Usb, Users, Wifi,
} from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { Printer, PrinterInput, ReceiptDesign, ReceiptDesignPreview, SerialPortInfo, Transport, UsbDevice, WindowsPrinter } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal, PageShell } from '../components/ui.tsx';
import { ReceiptLines } from '../components/print.tsx';
import { StoreSettings } from './StoreSettings.tsx';
import { UsersSettings } from './UsersSettings.tsx';
import { CouponsSettings } from './CouponsSettings.tsx';
import { DeviceSettings } from './DeviceSettings.tsx';
import { BackupSettings } from './BackupSettings.tsx';
import { onAndroid } from '../lib/android.ts';
import { useAddons } from '../lib/addons.ts';

type Section = string; // core sections, or one an add-on registered
const SECTION_KEY = 'pos.settings.section';
const readSection = (): Section => { try { return sessionStorage.getItem(SECTION_KEY) || 'printers'; } catch { return 'printers'; } };

type Kind = 'usb' | 'wifi' | 'bluetooth' | 'screen';
const KINDS: Array<{ kind: Kind; transport: Transport; label: string; hint: string; icon: typeof Usb }> = [
  { kind: 'usb', transport: 'spooler', label: 'USB', hint: 'Printer plugged into this PC with a USB cable', icon: Usb },
  { kind: 'wifi', transport: 'tcp', label: 'Wi-Fi / network', hint: 'Printer on the shop Wi-Fi or a network cable', icon: Wifi },
  { kind: 'bluetooth', transport: 'serial', label: 'Bluetooth', hint: 'Printer paired with this PC over Bluetooth', icon: Bluetooth },
  { kind: 'screen', transport: 'memory', label: 'Screen only', hint: 'No printer: bills can still be printed from the screen', icon: Monitor },
];
/** On Android, USB and Bluetooth printers are reached through the app ('android' transport, address usb:… or bt:…). */
const ANDROID_KINDS: Partial<Record<Kind, { transport: Transport; hint: string }>> = {
  usb: { transport: 'android', hint: 'Printer plugged into this device with a USB (OTG) cable' },
  bluetooth: { transport: 'android', hint: 'The built-in printer of this POS machine, or a printer paired over Bluetooth' },
};
const kindsHere = () => (onAndroid() ? KINDS.map((k) => ({ ...k, ...(ANDROID_KINDS[k.kind] ?? {}) })) : KINDS);
const kindOf = (t: Transport, address?: string | null): Kind => (t === 'android' ? ((address ?? '').startsWith('usb:') ? 'usb' : 'bluetooth') : t === 'spooler' || t === 'usb' ? 'usb' : t === 'tcp' ? 'wifi' : t === 'serial' ? 'bluetooth' : 'screen');
const connLabel = (p: { transport: Transport; address?: string | null }) => (p.transport === 'android' ? ((p.address ?? '').startsWith('usb:') ? 'USB (this device)' : 'Bluetooth / built-in') : p.transport === 'usb' ? 'USB (no driver needed)' : p.transport === 'spooler' ? 'USB (Windows printer)' : KINDS.find((k) => k.kind === kindOf(p.transport))!.label);
const when = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Settings() {
  const { user } = useSession();
  const [section, setSectionState] = useState<Section>(readSection);
  const setSection = (s: Section) => { setSectionState(s); try { sessionStorage.setItem(SECTION_KEY, s); } catch { /* storage unavailable */ } };
  const canManage = user?.role === 'manager' || user?.role === 'owner';
  const { addons } = useAddons();
  const addonSections = addons.flatMap((a) => a.settings ?? []).filter((s) => !s.roles || (user && s.roles.includes(user.role)));
  const items: Array<[Section, string, ComponentType<{ className?: string }>, string]> = [
    ['store', 'Store', Store, 'Name, address, GSTIN and bill logo'],
    ...addonSections.map((s) => [s.key, s.label, s.icon, s.hint] as [Section, string, ComponentType<{ className?: string }>, string]),
    ['printers', 'Printer setup', PrinterIcon, 'USB, Wi-Fi and Bluetooth printers, tests'],
    ['receipt', 'Receipt', ReceiptText, 'Bill design, footer and a sample'],
    ...(onAndroid() ? [['device', 'This device', Smartphone, 'Add-ons'] as [Section, string, ComponentType<{ className?: string }>, string]] : []),
    ...(user?.role === 'owner' ? [
      ['backups', 'Backups', DatabaseBackup, 'USB drive and online copies, restore'] as [Section, string, ComponentType<{ className?: string }>, string],
      ['coupons', 'Coupons', Ticket, 'Coupon codes for bills'] as [Section, string, ComponentType<{ className?: string }>, string],
      ['users', 'Users', Users, 'Staff, roles and PINs'] as [Section, string, ComponentType<{ className?: string }>, string],
    ] : []),
  ];
  const shown: Section = items.some(([k]) => k === section) ? section : 'printers';
  const AddonSection = addonSections.find((s) => s.key === shown)?.component;
  return (
    <PageShell route="settings" title="Settings" subtitle="Set up this counter.">
      {!canManage ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">Only a manager or owner can change settings.</p> : (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          {/* the section list scrolls on its own: sideways on narrow screens, and on wide screens it stays in view while the page scrolls */}
          <nav className="-mx-1 flex shrink-0 gap-2 overflow-x-auto px-1 pb-1 lg:sticky lg:top-0 lg:mx-0 lg:max-h-[calc(100vh-9rem)] lg:w-60 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:px-0 lg:pb-0 lg:pr-1" aria-label="Settings sections">
            {items.map(([key, label, Icon, hint]) => (
              <button key={key} onClick={() => setSection(key)} aria-current={shown === key ? 'page' : undefined}
                className={`flex shrink-0 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${shown === key ? 'border-primary bg-accent' : 'border-border bg-card hover:border-primary'}`}>
                <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${shown === key ? 'text-primary' : 'text-muted-foreground'}`} />
                <span><span className="block text-sm font-semibold">{label}</span><span className="hidden text-xs text-muted-foreground lg:block">{hint}</span></span>
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1">{AddonSection ? <AddonSection /> : shown === 'store' ? <StoreSettings /> : shown === 'printers' ? <PrinterSetup /> : shown === 'users' ? <UsersSettings /> : shown === 'coupons' ? <CouponsSettings /> : shown === 'device' ? <DeviceSettings /> : shown === 'backups' ? <BackupSettings /> : <ReceiptSettings />}</div>
        </div>
      )}
    </PageShell>
  );
}

// ---------------------------------------------------------------- Printer setup

function PrinterSetup() {
  const { api, fail, notify, withApproval } = useSession();
  const [list, setList] = useState<Printer[] | null>(null);
  const [devices, setDevices] = useState<UsbDevice[] | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<{ printer: Printer | null; prefill?: Partial<PrinterInput> } | null>(null);
  const [removing, setRemoving] = useState<Printer | null>(null);
  const [stations, setStations] = useState<string[]>([]);
  const keys = useRef(new Map<string, string>());

  const loadPrinters = useCallback(() => { api.printers().then(setList).catch((e) => { setList([]); fail(e); }); }, [api, fail]);
  const scan = useCallback(async (refresh: boolean) => {
    if (refresh) setScanning(true);
    try { const r = await api.usbDevices(refresh); setDevices(r.devices); setScannedAt(r.scannedAt); } catch { setDevices((d) => d ?? []); } finally { if (refresh) setScanning(false); }
  }, [api]);
  useEffect(() => {
    loadPrinters(); void scan(false);
    api.catalog().then((c) => setStations([...new Set(c.categories.map((x) => x.kitchenStation).filter((s): s is string => !!s))])).catch(() => { /* optional */ });
    const t = setInterval(() => { loadPrinters(); void scan(false); }, 6000); // printer status and newly plugged USB printers
    return () => clearInterval(t);
  }, [api, loadPrinters, scan]);
  const reload = () => { loadPrinters(); void scan(false); };

  // one-off actions keep their idempotency key until they succeed (a double click never prints twice)
  const once = async (id: string, label: string, run: (key: string) => Promise<unknown>) => {
    if (!keys.current.has(id)) keys.current.set(id, newKey());
    try { await run(keys.current.get(id)!); keys.current.delete(id); notify('info', label); setTimeout(loadPrinters, 1500); } catch (e) { keys.current.delete(id); fail(e); }
  };
  const quickAdd = async (d: UsbDevice) => {
    if (!keys.current.has(d.key)) keys.current.set(d.key, newKey());
    try {
      const r = await withApproval('Setting up a printer', (o) => api.quickAddPrinter(d.key, o, keys.current.get(d.key)));
      if (r) { keys.current.delete(d.key); notify('success', r.isReceipt ? `${r.name} now prints the bills. A test page is printing.` : `${r.name} is set up and printing a test page. Edit it to choose what it prints.`); reload(); }
    } catch (e) { keys.current.delete(d.key); fail(e); }
  };
  const toggle = async (p: Printer) => {
    try { const r = await api.updatePrinter(p.id, { active: !p.active }); notify('success', p.active ? `${p.name} turned off.${r.released ? ` ${r.released} waiting job(s) moved to failed.` : ''}` : `${p.name} turned on.`); reload(); } catch (e) { fail(e); }
  };
  const retry = async (p: Printer) => { try { const r = await api.retryFailed(p.id); notify('info', `${r.requeued} job(s) sent to ${p.name} again.`); loadPrinters(); } catch (e) { fail(e); } };
  const remove = async (p: Printer) => {
    try { const r = await api.deletePrinter(p.id); notify('success', r.removed ? `${p.name} removed.` : `${p.name} has print history, so it was turned off instead.`); reload(); } catch (e) { fail(e); } finally { setRemoving(null); }
  };

  const active = (list ?? []).filter((p) => p.active);
  const noReceipt = list !== null && !active.some((p) => p.isReceipt);
  const byId = new Map((list ?? []).map((p) => [p.id, p]));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-2xl">Printer setup</h2>
        <button className="btn-primary ml-auto" onClick={() => setEditing({ printer: null })}><Plus className="h-4 w-4" />Add printer</button>
      </div>
      {noReceipt && (
        <p className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/30 bg-card p-3 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><span><b>No printer prints the bills yet.</b> Plug in a USB printer below, or add a Wi-Fi or Bluetooth printer. Bills can still be printed from the screen.</span>
        </p>
      )}

      {/* ---------- plugged-in USB printers ---------- */}
      <section className="mb-6 rounded-2xl border border-border bg-card p-4" aria-label="USB printers plugged into this PC">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Usb className="h-5 w-5 text-primary" />
          <div className="min-w-48 flex-1">
            <h3 className="font-semibold">USB printers plugged into this PC</h3>
            <p className="text-xs text-muted-foreground">Plug in the printer and switch it on. It appears here within a few seconds, with or without a Windows driver.{scannedAt ? ` Last checked ${new Date(scannedAt).toLocaleTimeString('en-IN')}.` : ''}</p>
          </div>
          <button className="btn-ghost h-9" disabled={scanning} onClick={() => void scan(true)}><RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />{scanning ? 'Scanning…' : 'Scan again'}</button>
        </div>
        {devices === null ? <p className="text-sm text-muted-foreground">Looking for USB printers…</p> : devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No USB printer found.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>Check the USB cable at both ends and that the printer is switched on (its light is on).</li>
              <li>Wait 10 seconds, then press Scan again. If Windows offers a driver, you can skip it: the app prints without one.</li>
              <li>Printers on Wi-Fi or Bluetooth are added with Add printer.</li>
            </ul>
          </div>
        ) : (
          <ul className="space-y-2">
            {devices.map((d) => {
              const p = d.printerId ? byId.get(d.printerId) : undefined;
              return (
                <li key={d.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{d.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{d.detail} · {d.widthMm} mm paper (guess)</p>
                  </div>
                  {p ? (
                    <>
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${p.active ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}>
                        <CheckCircle2 className="h-3.5 w-3.5" />{p.active ? `Set up as "${p.name}"` : `"${p.name}" is turned off`}
                      </span>
                      {p.active && <button className="btn-ghost h-9" onClick={() => void once(`test:${p.id}`, `Test page sent to ${p.name}.`, (k) => api.testPrint(p.id, k))}><PrinterIcon className="h-4 w-4" />Test print</button>}
                    </>
                  ) : (
                    <>
                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">Not set up</span>
                      <button className="btn-primary h-9" onClick={() => void quickAdd(d)}>Use for bills</button>
                      <button className="btn-ghost h-9" onClick={() => setEditing({ printer: null, prefill: { name: d.name, transport: d.transport, address: d.address, widthMm: d.widthMm } })}>Set up with options</button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---------- configured printers ---------- */}
      <h3 className="mb-2 font-semibold">Your printers</h3>
      {list === null ? <p className="text-sm text-muted-foreground">Loading…</p> : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">No printers yet.</p>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {list.map((p) => {
            const Icon = KINDS.find((x) => x.kind === kindOf(p.transport, p.address))!.icon;
            return (
              <div key={p.id} className={`rounded-xl border bg-card p-4 ${p.active ? 'border-border' : 'border-dashed border-border opacity-70'}`}>
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary"><Icon className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{p.name} {!p.active && <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Off</span>}</p>
                    <p className="truncate text-sm text-muted-foreground">{connLabel(p)}{p.address ? ` · ${p.address}` : ''} · {p.widthMm} mm{p.profile === 'slow_buffer' ? ' · slow data speed' : ''}</p>
                    <p className="text-sm text-muted-foreground">
                      {[p.isReceipt && 'Bills (receipts)', p.drawer && 'Cash drawer', p.stations.length && `Kitchen: ${p.stations.map((s) => (s === '*' ? 'all stations' : s)).join(', ')}`].filter(Boolean).join(' · ') || 'Not printing anything yet: edit it to choose'}
                    </p>
                  </div>
                </div>
                <div className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
                  {p.stats.failed > 0 ? <span className="text-destructive">{p.stats.failed} job(s) failed{p.stats.lastError ? `: ${p.stats.lastError}` : ''}</span>
                    : p.stats.queued > 0 ? <span>{p.stats.queued} job(s) waiting to print…</span>
                    : p.stats.lastPrintedAt ? <span className="text-success">Working. Last printed {when(p.stats.lastPrintedAt)}</span>
                    : <span className="text-muted-foreground">Nothing printed yet. Send a test page.</span>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="btn-ghost h-9" disabled={!p.active} onClick={() => void once(`test:${p.id}`, `Test page sent to ${p.name}.`, (k) => api.testPrint(p.id, k))}><PrinterIcon className="h-4 w-4" />Test print</button>
                  <button className="btn-ghost h-9" disabled={!p.active} onClick={() => void once(`sample:${p.id}`, `Sample bill sent to ${p.name}.`, (k) => api.printSample(p.id, k))}><FileText className="h-4 w-4" />Sample bill</button>
                  {p.drawer && <button className="btn-ghost h-9" disabled={!p.active} onClick={() => void once(`drawer:${p.id}`, `Cash drawer on ${p.name} should open now.`, (k) => api.testDrawer(p.id, k))}><Banknote className="h-4 w-4" />Open drawer</button>}
                  {p.stats.failed > 0 && p.active && <button className="btn-ghost h-9 text-primary" onClick={() => void retry(p)}><RotateCw className="h-4 w-4" />Retry failed</button>}
                  <button className="btn-ghost h-9" onClick={() => setEditing({ printer: p })}><Pencil className="h-4 w-4" />Edit</button>
                  <button className="btn-ghost h-9" onClick={() => void toggle(p)}><Power className="h-4 w-4" />{p.active ? 'Turn off' : 'Turn on'}</button>
                  <button className="btn-ghost h-9 text-destructive" onClick={() => setRemoving(p)}><Trash2 className="h-4 w-4" />Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && <PrinterDialog printer={editing.printer} prefill={editing.prefill} stations={stations}
        hasReceipt={active.some((p) => p.isReceipt && (!editing.printer || p.id !== editing.printer.id))}
        onClose={() => setEditing(null)} onSaved={(isNew) => { setEditing(null); reload(); if (isNew) notify('success', 'Printer added. Press Test print to check it.'); }} />}
      {removing && (
        <Modal title="Remove printer?" onClose={() => setRemoving(null)}>
          <p className="text-sm text-muted-foreground">{removing.name} will stop printing. If it has printed before, it is kept as "off" so its history stays.</p>
          <div className="mt-5 flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setRemoving(null)}>Keep</button>
            <button className="btn-primary flex-1 bg-destructive" onClick={() => void remove(removing)}>Remove</button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PrinterDialog({ printer, prefill, stations, hasReceipt, onClose, onSaved }: {
  printer: Printer | null; prefill?: Partial<PrinterInput>; stations: string[]; hasReceipt: boolean; onClose: () => void; onSaved: (isNew: boolean) => void;
}) {
  const { api } = useSession();
  const key = useRef(newKey());
  const startTransport = printer?.transport ?? prefill?.transport ?? 'spooler';
  const [kind, setKind] = useState<Kind>(kindOf(startTransport, printer?.address ?? prefill?.address));
  const android = onAndroid();
  const [name, setName] = useState(printer?.name ?? prefill?.name ?? '');
  const [address, setAddress] = useState(printer?.address ?? prefill?.address ?? '');
  const [width, setWidth] = useState<58 | 80>(printer?.widthMm ?? prefill?.widthMm ?? 80);
  const [isReceipt, setIsReceipt] = useState(printer ? printer.isReceipt : !hasReceipt);
  const [drawer, setDrawer] = useState(printer?.drawer ?? !hasReceipt);
  const [chosen, setChosen] = useState<string[]>(printer?.stations ?? []);
  const [slow, setSlow] = useState(printer?.profile === 'slow_buffer');
  const [active, setActive] = useState(printer?.active ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const directUsb = startTransport === 'usb' && kind === 'usb'; // plug-and-play printer: keep its USB id
  const transport: Transport = directUsb ? 'usb' : kindsHere().find((k) => k.kind === kind)!.transport;
  const allStations = [...new Set([...stations, ...chosen.filter((s) => s !== '*')])];

  const pick = (addr: string, suggestedName?: string) => { setAddress(addr); if (!name.trim() && suggestedName) setName(suggestedName); };
  const toggleStation = (s: string) => setChosen((c) => (c.includes(s) ? c.filter((x) => x !== s) : s === '*' ? ['*'] : [...c.filter((x) => x !== '*'), s]));

  const save = async () => {
    if (!name.trim()) return setError('Give the printer a name, like "Counter" or "Kitchen".');
    if (kind !== 'screen' && !address.trim()) return setError(kind === 'usb' ? 'Choose the USB printer.' : kind === 'wifi' ? 'Enter or find the printer IP address.' : android ? 'Choose the printer.' : 'Choose the Bluetooth COM port.');
    if (!isReceipt && chosen.length === 0) return setError('Choose what this printer prints: bills, kitchen tickets, or both.');
    setBusy(true); setError('');
    const input: PrinterInput = { name: name.trim(), transport, address: kind === 'screen' ? null : address.trim(), widthMm: width, isReceipt, drawer: isReceipt && drawer, stations: chosen, active, profile: slow ? 'slow_buffer' : 'generic' };
    try {
      if (printer) await api.updatePrinter(printer.id, input, key.current); else await api.createPrinter(input, key.current);
      onSaved(!printer);
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <Modal title={printer ? `Edit ${printer.name}` : 'Add printer'} onClose={onClose} width="max-w-2xl">
      <div className="max-h-[75vh] overflow-y-auto pr-1">
        <Step n={1} title="How is the printer connected?">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4" role="radiogroup" aria-label="Connection">
            {kindsHere().map(({ kind: k, label, hint, icon: Icon }) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} title={hint}
                onClick={() => { if (k !== kind) { setKind(k); setAddress(k === kindOf(startTransport, printer?.address ?? prefill?.address) ? (printer?.address ?? prefill?.address ?? '') : ''); setError(''); } }}
                className={`flex flex-col items-center gap-1 rounded-xl border p-3 text-sm font-semibold transition-colors ${kind === k ? 'border-primary bg-accent text-primary' : 'border-border bg-background hover:border-primary'}`}>
                <Icon className="h-5 w-5" />{label}
              </button>
            ))}
          </div>
        </Step>

        {kind !== 'screen' && (
          <Step n={2} title={kind === 'usb' ? 'Which USB printer?' : kind === 'wifi' ? 'Which network printer?' : 'Which Bluetooth printer?'}>
            {android && (kind === 'usb' || kind === 'bluetooth') ? <AndroidPicker kind={kind} value={address} onPick={pick} /> : <>
            {kind === 'usb' && (directUsb
              ? <p className="rounded-xl border border-border bg-background p-3 text-sm">Plugged straight into USB, no driver needed (id <b>{address}</b>). It works in any USB socket of this PC.</p>
              : <UsbPicker value={address} onPick={pick} />)}
            {kind === 'wifi' && <WifiPicker value={address} onPick={pick} />}
            {kind === 'bluetooth' && <BluetoothPicker value={address} onPick={pick} />}
            </>}
          </Step>
        )}

        <Step n={kind === 'screen' ? 2 : 3} title="Name and paper">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Name</span>
              <input className="field" maxLength={60} placeholder="Counter, Kitchen…" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="text-sm"><span className="mb-1 block font-medium">Paper roll width</span>
              <div className="flex flex-wrap gap-2">{([80, 58] as const).map((w) => <button key={w} type="button" className={`chip ${width === w ? 'chip-active' : ''}`} onClick={() => setWidth(w)}>{w} mm · {w === 80 ? 48 : 32} chars</button>)}</div>
            </div>
          </div>
        </Step>

        <Step n={kind === 'screen' ? 3 : 4} title="What should it print?">
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={isReceipt} onChange={(e) => setIsReceipt(e.target.checked)} /> Customer bills (receipts)</label>
            {isReceipt && <label className="flex items-center gap-2 pl-6"><input type="checkbox" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} /> Open the cash drawer on cash bills (drawer cable plugged into this printer)</label>}
            <div>
              <span className="font-medium">Kitchen tickets (KOT) for</span>
              <div className="mt-1 flex flex-wrap gap-2">
                {allStations.map((s) => <button key={s} type="button" aria-pressed={chosen.includes(s)} className={`chip ${chosen.includes(s) ? 'chip-active' : ''}`} onClick={() => toggleStation(s)}>{s}</button>)}
                <button type="button" aria-pressed={chosen.includes('*')} className={`chip ${chosen.includes('*') ? 'chip-active' : ''}`} onClick={() => toggleStation('*')}>All stations</button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Stations come from your menu categories (Menu creation, Categories).</p>
            </div>
          </div>
        </Step>

        <Step n={kind === 'screen' ? 4 : 5} title="More options">
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={slow} onChange={(e) => setSlow(e.target.checked)} />
              <span>Slow data speed <span className="block text-xs text-muted-foreground">Turn on if long bills come out cut off or with missing lines (common on cheap or Bluetooth printers).</span></span></label>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={active} onChange={(e) => setActive(e.target.checked)} />
              <span>Printer is on <span className="block text-xs text-muted-foreground">Turn off to stop sending prints to it without removing it.</span></span></label>
          </div>
        </Step>
      </div>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : printer ? 'Save changes' : 'Add printer'}</button>
      </div>
    </Modal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">{n}</span>{title}</h3>
      {children}
    </section>
  );
}

function Picker({ title, loading, onRefresh, refreshLabel, children }: { title: string; loading: boolean; onRefresh: () => void; refreshLabel: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        <button type="button" className="btn-ghost ml-auto h-8 px-3 text-xs" disabled={loading} onClick={onRefresh}>
          {refreshLabel === 'Find printers' ? <Search className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}{loading ? 'Looking…' : refreshLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

const CONN_LABEL: Record<WindowsPrinter['connection'], string> = { usb: 'USB', serial: 'COM port', bluetooth: 'Bluetooth', network: 'Network', virtual: 'Not a printer (PDF / file)', other: 'Other' };

/** USB: plugged-in printers (driverless ones too) and printers installed in Windows. */
function UsbPicker({ value, onPick }: { value: string; onPick: (addr: string, name?: string) => void }) {
  const { api } = useSession();
  const [list, setList] = useState<WindowsPrinter[] | null>(null);
  const [usb, setUsb] = useState<UsbDevice[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true); setErr('');
    Promise.all([api.windowsPrinters().then(setList), api.usbDevices(true).then((r) => setUsb(r.devices.filter((d) => d.transport === 'usb' && !d.printerId)))])
      .catch((e) => setErr(messageOf(e))).finally(() => setLoading(false));
  }, [api]);
  useEffect(load, [load]);
  const sorted = (list ?? []).slice().sort((a, b) => Number(b.connection === 'usb') - Number(a.connection === 'usb'));
  return (
    <Picker title="Printers on this PC" loading={loading} onRefresh={load} refreshLabel="Refresh">
      {err && <p className="text-sm text-destructive">{err}</p>}
      {usb.length > 0 && <p className="mb-1 text-xs text-muted-foreground">Plugged in without a driver: set these up from the "USB printers plugged into this PC" list (Use for bills / Set up with options).</p>}
      {list?.length === 0 && <p className="text-sm text-muted-foreground">No printers are installed in Windows. If the printer is plugged in, it shows in the plugged-in list on the Printer setup page.</p>}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {sorted.map((p) => (
          <li key={p.name}>
            <button type="button" aria-pressed={value === p.name} onClick={() => onPick(p.name, p.name)}
              className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${value === p.name ? 'border-primary bg-accent' : 'border-transparent hover:bg-secondary'} ${p.connection === 'virtual' ? 'opacity-60' : ''}`}>
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{CONN_LABEL[p.connection]} · {p.port}{p.offline ? ' · offline' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      <label className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">Or type the Windows printer name
        <input className="field" value={value} maxLength={200} onChange={(e) => onPick(e.target.value)} aria-label="Windows printer name" />
      </label>
    </Picker>
  );
}

function WifiPicker({ value, onPick }: { value: string; onPick: (addr: string, name?: string) => void }) {
  const { api } = useSession();
  const [found, setFound] = useState<Array<{ host: string; address: string }> | null>(null);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const scan = async () => {
    setLoading(true); setErr('');
    try { const r = await api.discoverPrinters(); setFound(r.found); setScanned(r.scanned); } catch (e) { setErr(e instanceof ApiError ? e.message : messageOf(e)); } finally { setLoading(false); }
  };
  return (
    <Picker title="Printers on this network" loading={loading} onRefresh={() => void scan()} refreshLabel="Find printers">
      <p className="text-xs text-muted-foreground">The printer and this PC must be on the same Wi-Fi or network. Most receipt printers print their IP address when you hold the feed button while switching them on.</p>
      {err && <p className="mt-1 text-sm text-destructive">{err}</p>}
      {found && (found.length === 0
        ? <p className="mt-2 text-sm text-muted-foreground">No printer answered on port 9100 ({scanned} addresses checked). Check it is on and connected, or type its IP below.</p>
        : <ul className="mt-2 space-y-1">{found.map((f) => (
          <li key={f.address}><button type="button" aria-pressed={value === f.address} onClick={() => onPick(f.address, `Printer ${f.host.split('.').pop()}`)}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${value === f.address ? 'border-primary bg-accent' : 'border-transparent hover:bg-secondary'}`}>
            <Wifi className="h-4 w-4 text-muted-foreground" /><span className="font-medium">{f.host}</span><span className="text-xs text-muted-foreground">port 9100</span>
          </button></li>))}</ul>)}
      <label className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">Or type the IP address (port 9100 unless you add :port)
        <input className="field" value={value} maxLength={200} placeholder="192.168.1.50" onChange={(e) => onPick(e.target.value)} aria-label="Printer IP address" />
      </label>
    </Picker>
  );
}

/** Android: the USB or Bluetooth printers this device sees (the built-in printer of a POS machine is listed first). */
function AndroidPicker({ kind, value, onPick }: { kind: 'usb' | 'bluetooth'; value: string; onPick: (addr: string, name?: string) => void }) {
  const { api } = useSession();
  const [list, setList] = useState<UsbDevice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const prefix = kind === 'usb' ? 'usb:' : 'bt:';
  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.usbDevices(true).then((r) => setList(r.devices.filter((d) => d.transport === 'android' && d.address.startsWith(prefix)))).catch((e) => setErr(messageOf(e))).finally(() => setLoading(false));
  }, [api, prefix]);
  useEffect(load, [load]);
  return (
    <Picker title={kind === 'usb' ? 'USB printers on this device' : 'Built-in and Bluetooth printers'} loading={loading} onRefresh={load} refreshLabel="Refresh">
      <p className="mb-2 text-xs text-muted-foreground">{kind === 'usb'
        ? 'Plug the printer in with a USB (OTG) cable. The first print asks you to allow it: tap OK.'
        : 'A POS machine with a printer shows "Built-in printer". For another printer, pair it first in Android Settings, Bluetooth (PIN often 0000 or 1234), and allow Nearby devices for Tiffin POS.'}</p>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {list?.length === 0 && <p className="text-sm text-muted-foreground">{kind === 'usb' ? 'No USB printer is plugged in.' : 'No printer found. Pair it in Android Settings, then press Refresh.'}</p>}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {list?.map((d) => (
          <li key={d.key}><button type="button" aria-pressed={value === d.address} onClick={() => onPick(d.address, d.name)}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${value === d.address ? 'border-primary bg-accent' : 'border-transparent hover:bg-secondary'}`}>
            {kind === 'usb' ? <Usb className="h-4 w-4 text-primary" /> : <Bluetooth className="h-4 w-4 text-primary" />}
            <span className="font-medium">{d.name}</span><span className="min-w-0 truncate text-xs text-muted-foreground">{d.detail}{d.printerName ? ` · set up as ${d.printerName}` : ''}</span>
          </button></li>
        ))}
      </ul>
    </Picker>
  );
}

function BluetoothPicker({ value, onPick }: { value: string; onPick: (addr: string, name?: string) => void }) {
  const { api } = useSession();
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => { setLoading(true); setErr(''); api.serialPorts().then(setPorts).catch((e) => setErr(messageOf(e))).finally(() => setLoading(false)); }, [api]);
  useEffect(load, [load]);
  const sorted = (ports ?? []).slice().sort((a, b) => Number(b.bluetooth) - Number(a.bluetooth));
  return (
    <Picker title="COM ports" loading={loading} onRefresh={load} refreshLabel="Refresh">
      <ol className="mb-2 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
        <li>Turn the printer on and pair it in Windows: Settings, Bluetooth & devices, Add device (PIN is often 0000 or 1234).</li>
        <li>Open More Bluetooth settings, COM Ports, and note the <b>Outgoing</b> port for the printer.</li>
        <li>Choose that port here, then send a test page.</li>
      </ol>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {ports?.length === 0 && <p className="text-sm text-muted-foreground">No COM ports found. Pair the printer first, then press Refresh.</p>}
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {sorted.map((p) => (
          <li key={p.port}><button type="button" aria-pressed={value === p.port} onClick={() => onPick(p.port, p.bluetooth ? 'Bluetooth printer' : undefined)}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${value === p.port ? 'border-primary bg-accent' : 'border-transparent hover:bg-secondary'}`}>
            {p.bluetooth ? <Bluetooth className="h-4 w-4 text-primary" /> : <span className="w-4" />}
            <span className="font-medium">{p.port}</span><span className="min-w-0 truncate text-xs text-muted-foreground">{p.name}</span>
          </button></li>
        ))}
      </ul>
      <label className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">Or type the COM port (add :115200 for wired serial printers that need a speed)
        <input className="field" value={value} maxLength={20} placeholder="COM5" onChange={(e) => onPick(e.target.value.toUpperCase())} aria-label="COM port" />
      </label>
    </Picker>
  );
}

// ---------------------------------------------------------------- Receipt

function ReceiptSettings() {
  const { api, user, fail, notify } = useSession();
  const isOwner = user?.role === 'owner';
  const key = useRef(newKey());
  const [footer, setFooter] = useState<string | null>(null);
  const [width, setWidth] = useState<58 | 80>(80);
  const [lines, setLines] = useState<string[] | null>(null);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [design, setDesign] = useState<ReceiptDesign | null | undefined>(undefined);
  /** A chosen design file that is not applied yet: its preview replaces the current one until "Use" or "Cancel". */
  const [pending, setPending] = useState<{ fileName: string; content: string; preview: ReceiptDesignPreview | null; errors: string[] } | null>(null);
  const [confirmStandard, setConfirmStandard] = useState(false);
  const [logoV] = useState(() => Date.now()); // a fresh logo each time this section opens
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const preview = useCallback(() => { api.sampleReceipt(width).then((r) => setLines(r.lines)).catch(fail); }, [api, fail, width]);
  useEffect(preview, [preview]);
  const loadDesign = useCallback(() => { api.receiptDesign().then((d) => setDesign(d.active)).catch(() => setDesign(null)); }, [api]);
  useEffect(() => {
    loadDesign();
    if (isOwner) api.settings().then((s) => setFooter(s.receipt_footer ?? '')).catch(fail);
    api.printers().then((p) => { const a = p.filter((x) => x.active); setPrinters(a); setTarget((t) => t || a.find((x) => x.isReceipt)?.id || a[0]?.id || ''); }).catch(() => { /* optional */ });
  }, [api, fail, isOwner, loadDesign]);

  const check = useCallback(async (fileName: string, content: string, w: 58 | 80) => {
    try {
      const p = await api.previewReceiptDesign(fileName, content, w);
      if (pendingRef.current?.content === content) setPending({ fileName, content, preview: p, errors: [] });
    } catch (e) {
      const errors = e instanceof ApiError && Array.isArray((e.details as { errors?: unknown })?.errors) ? (e.details as { errors: string[] }).errors : [messageOf(e)];
      if (pendingRef.current?.content === content) setPending({ fileName, content, preview: null, errors });
    }
  }, [api]);
  // the preview follows the paper width
  useEffect(() => { const p = pendingRef.current; if (p) void check(p.fileName, p.content, width); }, [width, check]);

  const choose = async (f: File | undefined) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!f) return;
    if (f.size > 200_000) { setPending({ fileName: f.name, content: '', preview: null, errors: ['The file is too large. Is this the right file?'] }); return; }
    const content = await f.text();
    const p = { fileName: f.name, content, preview: null, errors: [] };
    pendingRef.current = p;
    setPending(p);
    await check(f.name, content, width);
  };
  const apply = async () => {
    if (!pending?.preview) return;
    setBusy(true);
    try {
      const r = await api.setReceiptDesign(pending.fileName, pending.content, key.current);
      key.current = newKey();
      setDesign(r.active); setPending(null);
      notify('success', `"${r.active.name}" is now the bill design. New bills print with it.`);
      preview();
    } catch (e) { key.current = newKey(); fail(e); } finally { setBusy(false); }
  };
  const useStandard = async () => {
    setBusy(true);
    try { await api.clearReceiptDesign(key.current); key.current = newKey(); setDesign(null); setConfirmStandard(false); notify('success', 'Bills print in the standard design again.'); preview(); }
    catch (e) { key.current = newKey(); fail(e); } finally { setBusy(false); }
  };
  const save = async () => {
    if (footer === null) return;
    setBusy(true);
    try { await api.saveSettings({ receipt_footer: footer.trim() }, key.current); key.current = newKey(); notify('success', 'Receipt footer saved. New bills use it.'); preview(); if (pending) void check(pending.fileName, pending.content, width); } catch (e) { key.current = newKey(); fail(e); } finally { setBusy(false); }
  };
  const printIt = async () => { if (!target) return; try { await api.printSample(target); notify('info', 'Sample bill sent to the printer.'); } catch (e) { fail(e); } };

  const shown = pending?.preview ? pending.preview.lines : lines;
  return (
    <>
      <h2 className="mb-4 font-display text-2xl">Receipt</h2>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card p-4" aria-label="Bill design">
            <h3 className="font-semibold">Bill design</h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Want bills to look like your old ones? Send a photo of your bill to your POS provider. They send back a design file ending in <b>.tiffinreceipt</b>; upload it here.
            </p>
            <div className="mb-3 flex items-start gap-3 rounded-xl border border-border bg-background p-3">
              <ReceiptText className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 text-sm">
                {design === undefined ? <p className="text-muted-foreground">Loading…</p> : design ? (
                  <>
                    <p className="font-semibold">{design.name}</p>
                    {design.description && <p className="text-xs text-muted-foreground">{design.description}</p>}
                    <p className="text-xs text-muted-foreground">From {design.fileName}, added {when(design.uploadedAt)}</p>
                  </>
                ) : <><p className="font-semibold">Standard design</p><p className="text-xs text-muted-foreground">The POS's built-in bill layout.</p></>}
              </div>
            </div>
            {!isOwner ? <p className="text-sm text-muted-foreground">Only the owner can change the bill design.</p> : (
              <>
                <input ref={fileInput} type="file" accept=".tiffinreceipt" className="hidden" aria-label="Bill design file" onChange={(e) => void choose(e.target.files?.[0])} />
                {pending ? (
                  <div className="space-y-3">
                    <p className="text-sm">Chosen file: <b>{pending.fileName}</b></p>
                    {pending.errors.length > 0 ? (
                      <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        <p className="mb-1 flex items-center gap-2 font-semibold"><CircleAlert className="h-4 w-4" />This design cannot be used</p>
                        <ul className="list-disc space-y-1 pl-5">{pending.errors.map((er) => <li key={er}>{er}</li>)}</ul>
                        <p className="mt-2 text-xs">Send these lines to your POS provider so they can fix the file.</p>
                      </div>
                    ) : pending.preview ? (
                      <p className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 className="h-4 w-4" />"{pending.preview.name}" looks good. Check the preview, then use it.</p>
                    ) : <p className="text-sm text-muted-foreground">Checking the file…</p>}
                    <div className="flex flex-wrap gap-2">
                      {pending.preview && <button className="btn-primary" disabled={busy} onClick={() => void apply()}>{busy ? 'Saving…' : 'Use this design'}</button>}
                      <button className="btn-ghost" onClick={() => fileInput.current?.click()}>Choose another file</button>
                      <button className="btn-ghost" onClick={() => setPending(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary" onClick={() => fileInput.current?.click()}><FileText className="h-4 w-4" />Upload design file</button>
                    {design && !confirmStandard && <button className="btn-ghost" onClick={() => setConfirmStandard(true)}>Back to standard design</button>}
                    {design && confirmStandard && (
                      <>
                        <button className="btn-primary bg-destructive" disabled={busy} onClick={() => void useStandard()}>Yes, use the standard design</button>
                        <button className="btn-ghost" onClick={() => setConfirmStandard(false)}>Keep {design.name}</button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="font-semibold">Footer text</h3>
            <p className="mb-2 text-xs text-muted-foreground">Printed at the bottom of every bill. The shop name, address, GSTIN and FSSAI come from the first-run setup.</p>
            {isOwner ? (
              <>
                <input className="field w-full" maxLength={200} value={footer ?? ''} onChange={(e) => setFooter(e.target.value)} placeholder="Thank you! Visit again." aria-label="Receipt footer" />
                <button className="btn-primary mt-3" disabled={busy || footer === null} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
              </>
            ) : <p className="text-sm text-muted-foreground">Only the owner can change the footer.</p>}
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            <h3 className="font-semibold">Print a sample bill</h3>
            <p className="mb-2 text-xs text-muted-foreground">Checks paper width, the header and the cutter. It is marked "SAMPLE - NOT A BILL".{pending ? ' It prints the design in use, not the one you are checking.' : ''}</p>
            {printers.length === 0 ? <p className="text-sm text-muted-foreground">Set up a printer first (Printer setup).</p> : (
              <div className="flex flex-wrap gap-2">
                <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Printer for the sample">
                  {printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn-ghost" onClick={() => void printIt()}><PrinterIcon className="h-4 w-4" />Print sample</button>
              </div>
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="font-semibold">{pending?.preview ? `Preview: ${pending.preview.name} (not in use yet)` : 'Preview'}</h3>
            <div className="ml-auto flex gap-2">{([80, 58] as const).map((w) => <button key={w} className={`chip ${width === w ? 'chip-active' : ''}`} onClick={() => setWidth(w)}>{w} mm</button>)}</div>
          </div>
          <div className={`overflow-auto rounded-lg border bg-white p-3 ${pending?.preview ? 'border-primary' : 'border-border'}`}>
            {!shown ? <p className="text-sm text-muted-foreground">Loading…</p> : <ReceiptLines lines={shown} logoUrl={api.logoUrl(logoV)} className="mx-auto w-fit text-[11px]" />}
          </div>
        </div>
      </div>
    </>
  );
}
