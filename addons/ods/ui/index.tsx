// ODS add-on: registers its screens with the POS (window.__POS__.register).
import { AlarmClock, BellRing, BellOff, Globe, MapPinned, MonitorPlay } from 'lucide-react';
import { useEffect, useState } from 'react';
import { dismissRecent, silence, silenceLate, startBuzzer, useBuzzer } from './buzzer.ts';
import { host } from './host.ts';
import { onlineEnabled, useOnlineConfig } from './online.ts';
import { OnlineSettings } from './OnlineSettings.tsx';
import { Ods } from './Ods.tsx';
import { Serviceability } from './Serviceability.tsx';

declare const __ADDON_CSS__: string; // this add-on's own style sheet, built with the POS's theme (scripts/build.mjs)
const style = document.createElement('style');
style.dataset.addon = 'ods';
style.textContent = __ADDON_CSS__;
document.head.appendChild(style);

/** Bottom of the side menu: online or offline, and loads the setting so ODS shows when it is on. */
function StatusDot() {
  const online = useOnlineConfig();
  const on = online?.enabled === true;
  useEffect(() => { if (on) startBuzzer(); }, [on]);
  const { connected, waiting } = useBuzzer();
  const count = on ? waiting.length : 0;
  const green = on && connected === true;
  const label = count > 0 ? `${count} new online order${count > 1 ? 's' : ''} waiting` : !on ? 'Offline mode: online orders are off' : connected === true ? 'Online orders on: connected' : connected === null ? 'Online orders on: connecting…' : 'Online orders on, but not connected to the order hub';
  return (
    <>
      <a href={on ? '#/ods' : '#/settings'} className="group relative mb-1 flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary hover:text-primary" aria-label={label}>
        <Globe className="h-5 w-5" />
        {count > 0
          // new orders waiting: their number instead of the dot
          ? <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-bold leading-none text-white ring-2 ring-card" aria-hidden>{count > 99 ? '99+' : count}</span>
          : <span className={`absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-card ${green ? 'bg-veg' : 'bg-destructive'}`} />}
        <span aria-hidden className="rail-tip">{label}</span>
      </a>
      {on && <OrderAlert />}
    </>
  );
}

/** On any screen but the ODS: a banner while online orders wait to be accepted (the buzzer rings meanwhile), for a
 * while after new ones were accepted automatically, or while orders in the kitchen are past their ready time. */
function OrderAlert() {
  const { waiting, silenced, soundOn, recent, late, lateSilenced } = useBuzzer();
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => { const f = () => setRoute(window.location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  if (/^#\/?ods/.test(route)) return null;
  if (!waiting.length && recent.length) {
    return (
      <div role="status" className="fixed left-1/2 top-3 z-[2000] flex w-[min(92vw,560px)] -translate-x-1/2 items-center gap-3 rounded-2xl border-2 border-primary bg-card p-3 shadow-2xl">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white"><BellRing className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">New online order{recent.length > 1 ? 's' : ''} {recent.join(', ')}</p>
          <p className="text-xs text-muted-foreground">Accepted automatically: the bill and kitchen ticket are printing.{!soundOn ? ' Sound is off on the ODS.' : ''}</p>
        </div>
        <button className="btn-ghost h-10 shrink-0 px-3" onClick={dismissRecent}>OK</button>
        <a className="btn-primary h-10 shrink-0 px-4" href="#/ods" onClick={dismissRecent}>Open ODS</a>
      </div>
    );
  }
  if (!waiting.length && late.length) {
    return (
      <div role="alert" className="fixed left-1/2 top-3 z-[2000] flex w-[min(92vw,560px)] -translate-x-1/2 items-center gap-3 rounded-2xl border-2 border-destructive bg-card p-3 shadow-2xl">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-destructive text-white ${lateSilenced || !soundOn ? '' : 'animate-pulse'}`}><AlarmClock className="h-6 w-6" /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Running late: {late.map((o) => o.number).slice(0, 3).join(', ')}{late.length > 3 ? ` (+${late.length - 3} more)` : ''}</p>
          <p className="text-xs text-muted-foreground">{lateSilenced ? 'Alarm silenced. ' : !soundOn ? 'Sound is off on the ODS. ' : ''}The promised ready time has passed. Mark it Ready on the ODS when it is done.</p>
        </div>
        {!lateSilenced && soundOn && <button className="btn-ghost h-10 shrink-0 px-3" onClick={silenceLate} aria-label="Silence the late alarm"><BellOff className="h-4 w-4" />Silence</button>}
        <a className="btn-primary h-10 shrink-0 px-4" href="#/ods">Open ODS</a>
      </div>
    );
  }
  if (!waiting.length) return null;
  const first = waiting[0]!;
  return (
    <div role="alert" className="fixed left-1/2 top-3 z-[2000] flex w-[min(92vw,560px)] -translate-x-1/2 items-center gap-3 rounded-2xl border-2 border-primary bg-card p-3 shadow-2xl">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white ${silenced || !soundOn ? '' : 'animate-pulse'}`}><BellRing className="h-6 w-6" /></span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">New online order {first.number}{waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''}</p>
        <p className="text-xs text-muted-foreground">{silenced ? 'Buzzer silenced. ' : !soundOn ? 'Sound is off on the ODS. ' : ''}Accept or reject it on the ODS.</p>
      </div>
      {!silenced && soundOn && <button className="btn-ghost h-10 shrink-0 px-3" onClick={silence} aria-label="Silence the buzzer"><BellOff className="h-4 w-4" />Silence</button>}
      <a className="btn-primary h-10 shrink-0 px-4" href="#/ods">Open ODS</a>
    </div>
  );
}

host.register({
  id: 'ods',
  nav: [{ route: 'ods', label: 'ODS (online orders)', icon: MonitorPlay, visible: onlineEnabled }],
  routes: { ods: () => (onlineEnabled() ? <Ods /> : null) },
  settings: [
    { key: 'online', label: 'Online orders', hint: 'Sales channels, payments, accepting (off = offline mode)', icon: Globe, component: OnlineSettings, roles: ['owner', 'manager'] },
    { key: 'serviceability', label: 'Serviceability', hint: 'Delivery areas on a map (free or Google), fees, minimum order, hours', icon: MapPinned, component: Serviceability, roles: ['owner', 'manager'] },
  ],
  railFooter: StatusDot,
});
