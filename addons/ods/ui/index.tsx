// ODS add-on: registers its screens with the POS (window.__POS__.register).
import { Globe, KeyRound, MapPinned, MonitorPlay } from 'lucide-react';
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
  return (
    <span className="group relative mb-1 flex h-8 w-8 items-center justify-center" tabIndex={0} aria-label={on ? 'Online orders on' : 'Offline mode'}>
      <span className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-veg' : 'bg-muted-foreground/40'}`} />
      <span aria-hidden className="rail-tip">{on ? 'Online orders on' : 'Offline mode: no internet needed'}</span>
    </span>
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
