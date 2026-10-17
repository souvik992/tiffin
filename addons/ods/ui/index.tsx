// ODS add-on: registers its screens with the POS (window.__POS__.register).
import { BellRing, BellOff, Globe, KeyRound, MapPinned, MonitorPlay } from 'lucide-react';
import { useEffect, useState } from 'react';
import { silence, startBuzzer, useBuzzer } from './buzzer.ts';
import { host } from './host.ts';
import { onlineEnabled, useOnlineConfig } from './online.ts';
import { OnlineSettings } from './OnlineSettings.tsx';
import { Ods } from './Ods.tsx';
import { Serviceability } from './Serviceability.tsx';
import { ApiKeys } from './ApiKeys.tsx';

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
  return (
    <>
      <span className="group relative mb-1 flex h-8 w-8 items-center justify-center" tabIndex={0} aria-label={on ? 'Online orders on' : 'Offline mode'}>
        <span className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-veg' : 'bg-muted-foreground/40'}`} />
        <span aria-hidden className="rail-tip">{on ? 'Online orders on' : 'Offline mode: no internet needed'}</span>
      </span>
      {on && <OrderAlert />}
    </>
  );
}

/** On any screen but the ODS: a banner while online orders wait to be accepted (the buzzer rings meanwhile). */
function OrderAlert() {
  const { waiting, silenced, soundOn } = useBuzzer();
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => { const f = () => setRoute(window.location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  if (!waiting.length || /^#\/?ods/.test(route)) return null;
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
    { key: 'serviceability', label: 'Serviceability', hint: 'Delivery areas on a map, fees, minimum order, hours', icon: MapPinned, component: Serviceability, roles: ['owner', 'manager'] },
    { key: 'api-keys', label: 'API keys', hint: 'Google Maps key for the map and place search', icon: KeyRound, component: ApiKeys, roles: ['owner'] },
  ],
  railFooter: StatusDot,
});
