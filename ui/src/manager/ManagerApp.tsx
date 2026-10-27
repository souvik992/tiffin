import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, Boxes, ClipboardList, Database, DatabaseBackup, Eye, FileArchive, FolderOpen, HardDrive, LayoutDashboard, LogOut, Pencil, ShoppingCart, Store, UtensilsCrossed } from 'lucide-react';
import { SessionProvider, useSession } from '../lib/session.tsx';
import { AppModeProvider } from '../lib/appMode.tsx';
import type { NavItem } from '../lib/appMode.tsx';
import { ApprovalDialog, Notices, PageShell, PinPad } from '../components/ui.tsx';
import type { LoginUser } from '../lib/api.ts';
import { isMobile, mobileDigits } from '../lib/pin.ts';
import { MenuItems } from '../screens/MenuItems.tsx';
import { Orders } from '../screens/Orders.tsx';
import { Stock } from '../screens/Stock.tsx';
import { Purchases } from '../screens/Purchases.tsx';
import { Reports } from '../screens/Reports.tsx';
import { StoreSettings } from '../screens/StoreSettings.tsx';
import { UsersSettings } from '../screens/UsersSettings.tsx';
import { CouponsSettings } from '../screens/CouponsSettings.tsx';
import { Dashboard } from './Dashboard.tsx';
import { AllData } from './AllData.tsx';
import { Backups } from './Backups.tsx';
import { choose, mgr } from './mgr.ts';
import type { Status } from './mgr.ts';

// Tiffin Data Manager: the shop's data for the owner, from any computer with the data folder or a backup file.
// The menu, stock, staff and reports are the POS's own screens; bills are view only (the POS does billing).

const NAV: NavItem[] = [
  { to: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: 'orders', label: 'Bills', icon: ClipboardList },
  { to: 'reports', label: 'Reports', icon: BarChart3 },
  { to: 'menu-items', label: 'Menu', icon: UtensilsCrossed },
  { to: 'stock', label: 'Stock', icon: Boxes },
  { to: 'purchases', label: 'Purchases', icon: ShoppingCart },
  { to: 'shop', label: 'Store, staff and coupons', icon: Store },
  { to: 'data', label: 'All data', icon: Database },
  { to: 'backups', label: 'Backups', icon: DatabaseBackup },
];
const parseRoute = () => window.location.hash.replace(/^#\/?/, '') || 'dashboard';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-col items-center justify-center bg-background p-6 text-center">{children}</div>;
}
function Logo() {
  return <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary font-display text-2xl text-primary-foreground">T</div>;
}

/** Open this computer's data, another data folder, or a backup file. */
function SourceButtons({ onStatus, compact }: { onStatus: (s: Status) => void; compact?: boolean }) {
  const { fail } = useSession();
  const open = async (origin: 'data' | 'folder' | 'file') => {
    const path = origin === 'data' ? undefined : await choose(origin);
    if (origin !== 'data' && !path) return;
    try { onStatus(await mgr.open(origin, path ?? undefined)); } catch (e) { fail(e); }
  };
  const cls = compact ? 'btn-ghost h-8 px-2.5 text-xs' : 'btn-ghost';
  return (
    <div className={`flex flex-wrap gap-2 ${compact ? '' : 'justify-center'}`}>
      <button className={cls} onClick={() => void open('data')}><HardDrive className="h-4 w-4" />This computer's POS data</button>
      <button className={cls} onClick={() => void open('folder')}><FolderOpen className="h-4 w-4" />A data folder…</button>
      <button className={cls} onClick={() => void open('file')}><FileArchive className="h-4 w-4" />A backup file…</button>
    </div>
  );
}

function OwnerLogin({ status }: { status: Status }) {
  const { api, signIn } = useSession();
  const [owners, setOwners] = useState<LoginUser[] | null>(null);
  const [mobile, setMobile] = useState('');
  const [picked, setPicked] = useState<LoginUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.loginUsers().then(setOwners).catch(() => setOwners([])); }, [api, status.source?.path]);

  const submit = async (pin: string) => {
    if (!picked && !isMobile(mobile)) { setError('Enter your 10-digit mobile number first.'); return; }
    setBusy(true); setError('');
    try { await signIn(picked ? { userId: picked.id } : { mobile }, pin); } catch (e) {
      setError((e as { message?: string }).message ?? 'Wrong mobile number or PIN.');
    } finally { setBusy(false); }
  };
  return (
    <Centered>
      <Logo />
      <h1 className="font-display text-3xl">Tiffin Data Manager</h1>
      <p className="mb-1 text-sm text-muted-foreground">{status.source?.store ?? 'Your shop'}: sign in as the owner.</p>
      <p className="mb-6 max-w-md break-all text-xs text-muted-foreground">{status.source?.path}</p>
      {owners && owners.length === 0 ? <p className="mb-6 max-w-sm text-sm">This data has no owner who can sign in yet. Set the shop up in Tiffin POS first.</p> : (
        <>
          {!picked && (
            <label className="mb-5 flex w-full max-w-xs flex-col gap-1 text-left text-sm">
              <span className="font-medium">Owner's mobile number</span>
              <input className="field text-center text-lg tabular-nums tracking-wider" inputMode="numeric" maxLength={10} placeholder="10 digits" value={mobile} autoFocus aria-label="Mobile number"
                onChange={(e) => { const v = mobileDigits(e.target.value); setMobile(v); setError(''); if (v.length === 10) e.target.blur(); }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            </label>
          )}
          <PinPad key={picked?.id ?? 'mobile'} busy={busy} label={picked ? `PIN for ${picked.name}` : 'PIN'} onSubmit={(pin) => void submit(pin)} />
          {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
          {owners && owners.some((u) => !u.hasMobile) && (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {picked ? <button className="btn-ghost" onClick={() => setPicked(null)}>Use a mobile number</button>
                : owners.filter((u) => !u.hasMobile).map((u) => <button key={u.id} className="chip" onClick={() => { setPicked(u); setError(''); }}>{u.name}</button>)}
            </div>
          )}
        </>
      )}
    </Centered>
  );
}

function Banner({ status, onStatus }: { status: Status; onStatus: (s: Status) => void }) {
  const { user, signOut } = useSession();
  const s = status.source!;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2 text-sm ${s.editable ? 'border-border bg-card' : 'border-primary/30 bg-accent text-accent-foreground'}`}>
      {s.editable ? <Pencil className="h-4 w-4 shrink-0 text-success" /> : <Eye className="h-4 w-4 shrink-0" />}
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{s.store ?? 'Shop data'}</span>
        <span className="mx-1.5 text-muted-foreground">·</span>
        {s.editable ? <span>You can make changes. <span className="text-muted-foreground">({s.path})</span></span> : <span title={s.path}>View only. {s.viewOnly}</span>}
      </p>
      <SourceButtons onStatus={onStatus} compact />
      {user && <button className="btn-ghost h-8 px-2.5 text-xs" onClick={() => void signOut()}><LogOut className="h-4 w-4" />Sign out {user.name}</button>}
    </div>
  );
}

function Screens() {
  const { user, restore } = useSession();
  const [status, setStatus] = useState<Status | null>(null);
  const [route, setRoute] = useState(parseRoute);
  const [restored, setRestored] = useState(false);

  const poll = useCallback(() => { mgr.status().then(setStatus).catch(() => { /* starting */ }); }, []);
  useEffect(() => { poll(); const t = setInterval(poll, 3000); return () => clearInterval(t); }, [poll]);
  useEffect(() => { void restore().finally(() => setRestored(true)); }, [restore]);
  // the data was reopened (POS opened or closed, another folder or file): check the sign-in still holds there
  const sourceKey = status?.source ? `${status.source.path}|${status.source.kind}` : '';
  useEffect(() => { if (sourceKey && user) void restore(); }, [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  if (!status || !restored) return <Centered><p className="text-muted-foreground">Loading…</p></Centered>;
  if (!status.source) {
    return (
      <Centered>
        <Logo />
        <h1 className="font-display text-3xl">Tiffin Data Manager</h1>
        <p className="mt-2 max-w-lg text-sm text-muted-foreground">{status.error?.message ?? 'No data is open.'}</p>
        <p className="mb-6 mt-1 max-w-lg break-all text-xs text-muted-foreground">Looked in {status.dataDir}</p>
        <SourceButtons onStatus={setStatus} />
      </Centered>
    );
  }
  if (!user) return <OwnerLogin status={status} />;

  const screen = (() => {
    switch (route) {
      case 'orders': return <Orders />;
      case 'reports': return <Reports />;
      case 'menu-items': return <MenuItems />;
      case 'stock': return <Stock />;
      case 'purchases': return <Purchases />;
      case 'shop': return (
        <PageShell route="shop" title="Store, staff and coupons" subtitle="Store details on the bill, who can sign in, and discount coupons.">
          <div className="max-w-4xl space-y-8"><StoreSettings onChanged={poll} /><UsersSettings /><CouponsSettings /></div>
        </PageShell>
      );
      case 'data': return <AllData />;
      case 'backups': return <Backups onChanged={poll} />;
      default: return <Dashboard />;
    }
  })();
  return (
    <div className="flex h-full flex-col">
      <Banner status={status} onStatus={setStatus} />
      <div className="min-h-0 flex-1" key={sourceKey}>{screen}</div>
    </div>
  );
}

export function ManagerApp() {
  return (
    <AppModeProvider value={{ manager: true, nav: NAV, mark: 'D' }}>
      <SessionProvider>
        <Screens />
        <ApprovalDialog />
        <Notices />
      </SessionProvider>
    </AppModeProvider>
  );
}
