import { useEffect, useState } from 'react';
import { SessionProvider, useSession } from './lib/session.tsx';
import { ApprovalDialog, Notices } from './components/ui.tsx';
import type { Route } from './components/ui.tsx';
import { Login, Centered } from './screens/Login.tsx';
import { LockScreen } from './screens/LockScreen.tsx';
import { Billing } from './screens/Billing.tsx';
import { MenuItems } from './screens/MenuItems.tsx';
import { Orders } from './screens/Orders.tsx';
import { Stock } from './screens/Stock.tsx';
import { Purchases } from './screens/Purchases.tsx';
import { Settings } from './screens/Settings.tsx';
import { Reports } from './screens/Reports.tsx';
import { loadAddonScreens, useAddons } from './lib/addons.ts';
import { LicenceBanner, LicenceLock, useLicence } from './screens/Licence.tsx';
import { PrintAlarm } from './components/PrintAlarm.tsx';

// Hash routes (#/orders) work the same from the dev server and from file:// inside the Electron host.
// Unknown names may be add-on screens, which load after sign-in.
const parseRoute = (): Route => window.location.hash.replace(/^#\/?/, '') || 'billing';

function Screens() {
  const lic = useLicence();
  // P8-10: no usable licence: only the licence lock screen (sign-in and everything else are locked by the backend too)
  if (lic.licence && !lic.licence.usable) return <LicenceLock licence={lic.licence} onChanged={lic.set} />;
  return <><LicenceBanner licence={lic.licence} /><SignedIn /></>;
}

function SignedIn() {
  const { user, locked, restore, api } = useSession();
  const [route, setRoute] = useState<Route>(parseRoute);
  const [restoring, setRestoring] = useState(true);
  const { addons, ready } = useAddons();
  useEffect(() => { if (user && !locked) void loadAddonScreens(api); }, [api, user, locked]);
  useEffect(() => { void restore().finally(() => setRestoring(false)); }, [restore]);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (restoring) return <Centered><p className="text-muted-foreground">Loading…</p></Centered>;
  if (locked) return <LockScreen />; // nothing else is on screen (or reachable by keyboard) while locked
  if (!user) return <Login />;
  return <><Screen route={route} addons={addons} ready={ready} /><PrintAlarm /></>;
}

function Screen({ route, addons, ready }: { route: Route; addons: ReturnType<typeof useAddons>['addons']; ready: boolean }) {
  switch (route) {
    case 'menu-items': return <MenuItems />;
    case 'orders': return <Orders />;
    case 'stock': return <Stock />;
    case 'purchases': return <Purchases />;
    case 'reports': return <Reports />;
    case 'settings': return <Settings />;
    case 'billing': return <Billing />;
    default: {
      const Screen = addons.flatMap((a) => Object.entries(a.routes ?? {})).find(([r]) => r === route)?.[1];
      if (Screen) return <Screen />;
      if (!ready) return <Centered><p className="text-muted-foreground">Loading…</p></Centered>;
      return <Billing />; // unknown, or an add-on screen that is not available
    }
  }
}

export function App() {
  return (
    <SessionProvider>
      <Screens />
      <ApprovalDialog />
      <Notices />
    </SessionProvider>
  );
}
