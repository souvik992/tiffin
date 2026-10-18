import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, Link2, Settings2, WifiOff } from 'lucide-react';
import { MenuSyncDialog } from './MenuSync.tsx';
import { ChannelBadge } from './channels.tsx';
import { BASE, host } from './host.ts';
import { CHANNEL_LABELS, setOnlineConfig, useOnlineConfig } from './online.ts';
import type { OnlineConfig, OnlineSettingsInput } from './online.ts';

const { useSession, newKey, messageOf } = host;

type Channel = keyof OnlineConfig['channels'];
const HINTS: Record<Channel, string> = {
  app: "Orders from the store's own mobile app.",
  website: "Orders from the store's own ordering website.",
  swiggy: 'Orders placed on Swiggy for this store.',
  zomato: 'Orders placed on Zomato for this store.',
};
const TIMEOUTS = [2, 3, 5, 7, 10, 15];
const inputOf = (c: OnlineConfig): OnlineSettingsInput => ({
  enabled: c.enabled, channels: { ...c.channels }, acceptMode: c.acceptMode, acceptTimeoutMin: c.acceptTimeoutMin,
  fulfilment: { ...c.fulfilment }, payments: { ...c.payments },
});

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}
function Row({ title, hint, children }: { title: ReactNode; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1"><div className="mb-1 text-sm font-semibold">{title}</div><p className="text-xs text-muted-foreground">{hint}</p></div>
      {children}
    </div>
  );
}

/** Settings > Online orders: the master switch (off = offline mode), sales channels, order types, payments and accepting. */
export function OnlineSettings() {
  const { api, user, notify } = useSession();
  const isOwner = user?.role === 'owner';
  const saved = useOnlineConfig();
  const key = useRef(newKey());
  const [draft, setDraft] = useState<OnlineSettingsInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState<Channel | null>(null);
  useEffect(() => { if (saved && !draft) setDraft(inputOf(saved)); }, [saved, draft]);
  useEffect(() => { setError(null); }, [draft]); // an old message goes away as soon as something changes
  if (!draft || !saved) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const changed = JSON.stringify(draft) !== JSON.stringify(inputOf(saved));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const c = await api.request<OnlineConfig>('PUT', `${BASE}/config`, draft, key.current);
      key.current = newKey();
      setOnlineConfig(c);
      setDraft(inputOf(c));
      notify('success', c.enabled ? 'Online orders are on. ODS is now in the side menu.' : 'Online orders are off. The POS works in offline mode.');
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  const set = (patch: Partial<OnlineSettingsInput>) => setDraft({ ...draft, ...patch });

  return (
    <>
      <h2 className="mb-4 font-display text-2xl">Online orders</h2>
      <div className="max-w-2xl space-y-4">
        <section className="rounded-2xl border border-border bg-card p-4" aria-label="Online orders switch">
          <div className="flex items-start gap-4">
            {draft.enabled ? <Globe className="mt-0.5 h-6 w-6 shrink-0 text-primary" /> : <WifiOff className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" />}
            <div className="flex-1">
              <h3 className="font-semibold">Take online orders</h3>
              <p className="text-sm text-muted-foreground">
                {draft.enabled
                  ? 'On: the ODS (order display screen) appears in the side menu, and this POS may connect to the internet to receive orders from the channels below.'
                  : 'Off: offline mode. Billing works without internet and the POS makes no internet connection for orders.'}
              </p>
            </div>
            <Toggle on={draft.enabled} disabled={!isOwner} label="Take online orders" onChange={(v) => set({ enabled: v })} />
          </div>
        </section>

        {draft.enabled && (
          <>
            <section className="rounded-2xl border border-border bg-card p-4" aria-label="Sales channels">
              <h3 className="mb-1 font-semibold">Sales channels</h3>
              <p className="text-sm text-muted-foreground">Where online orders come from. Turn on at least one.</p>
              <div className="divide-y divide-border">
                {(Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => (
                  <Row key={c} title={<ChannelBadge channel={c} size="md" />} hint={HINTS[c]}>
                    <button type="button" className="btn-ghost h-9 px-3" onClick={() => setSyncing(c)} aria-label={`${CHANNEL_LABELS[c]} menu sync settings`} title="Menu sync: items and prices for this channel">
                      <Settings2 className="h-4 w-4" />Menu sync
                    </button>
                    <Toggle on={draft.channels[c]} disabled={!isOwner} label={CHANNEL_LABELS[c]} onChange={(v) => set({ channels: { ...draft.channels, [c]: v } })} />
                  </Row>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-4" aria-label="Order types">
              <h3 className="mb-1 font-semibold">Order types</h3>
              <div className="divide-y divide-border">
                <Row title="Pickup" hint="The customer collects the order at the counter.">
                  <Toggle on={draft.fulfilment.pickup} disabled={!isOwner} label="Pickup" onChange={(v) => set({ fulfilment: { ...draft.fulfilment, pickup: v } })} />
                </Row>
                <Row title="Delivery" hint="Your own riders deliver. You note the rider when the order goes out.">
                  <Toggle on={draft.fulfilment.delivery} disabled={!isOwner} label="Delivery" onChange={(v) => set({ fulfilment: { ...draft.fulfilment, delivery: v } })} />
                </Row>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-4" aria-label="Payments">
              <h3 className="mb-1 font-semibold">Payments</h3>
              <div className="divide-y divide-border">
                <Row title="Online payment" hint="UPI, cards and wallets through your payment gateway. Guests (no OTP) can order this way.">
                  <Toggle on={draft.payments.online} disabled={!isOwner} label="Online payment" onChange={(v) => set({ payments: { ...draft.payments, online: v } })} />
                </Row>
                <Row title="Cash on delivery / at pickup" hint="Only for customers who verified their mobile with an OTP, to stop fake orders.">
                  <Toggle on={draft.payments.cod} disabled={!isOwner} label="Cash on delivery" onChange={(v) => set({ payments: { ...draft.payments, cod: v } })} />
                </Row>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-4" aria-label="Accepting orders">
              <h3 className="mb-2 font-semibold">Accepting orders</h3>
              <div className="space-y-2" role="radiogroup" aria-label="Accept mode">
                <label className={`flex items-start gap-3 rounded-xl border p-3 ${draft.acceptMode === 'manual' ? 'border-primary bg-accent' : 'border-border'}`}>
                  <input type="radio" name="accept" className="mt-1" checked={draft.acceptMode === 'manual'} disabled={!isOwner} onChange={() => set({ acceptMode: 'manual' })} aria-label="Manual" />
                  <span className="flex-1">
                    <span className="block text-sm font-semibold">Manual</span>
                    <span className="text-xs text-muted-foreground">Staff accept or reject each order on the ODS. Not answered in time: the order is rejected and the customer refunded.</span>
                    <span className="mt-2 flex items-center gap-2 text-sm">Time to accept
                      <select className="field h-9" value={draft.acceptTimeoutMin} disabled={!isOwner || draft.acceptMode !== 'manual'} onChange={(e) => set({ acceptTimeoutMin: Number(e.target.value) })} aria-label="Time to accept">
                        {TIMEOUTS.map((m) => <option key={m} value={m}>{m} minutes</option>)}
                      </select>
                    </span>
                  </span>
                </label>
                <label className={`flex items-start gap-3 rounded-xl border p-3 ${draft.acceptMode === 'auto' ? 'border-primary bg-accent' : 'border-border'}`}>
                  <input type="radio" name="accept" className="mt-1" checked={draft.acceptMode === 'auto'} disabled={!isOwner} onChange={() => set({ acceptMode: 'auto' })} aria-label="Automatic" />
                  <span>
                    <span className="block text-sm font-semibold">Automatic</span>
                    <span className="text-xs text-muted-foreground">Every order is accepted, billed and sent to the kitchen as soon as it arrives.</span>
                  </span>
                </label>
              </div>
            </section>
          </>
        )}

        {saved.enabled && <HubCard isOwner={isOwner} />}
        <p className="rounded-xl border border-border bg-background p-3 text-xs text-muted-foreground">
          App and website orders arrive through the order hub. Swiggy and Zomato also need this store to be onboarded with them as an integration partner (not built yet).
        </p>
        {syncing && <MenuSyncDialog channel={syncing} readOnly={!isOwner} onClose={() => setSyncing(null)} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {isOwner ? (
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || !changed} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
            {changed && <button className="btn-ghost" onClick={() => setDraft(inputOf(saved))}>Undo changes</button>}
          </div>
        ) : <p className="text-sm text-muted-foreground">Only the owner can change online orders.</p>}
      </div>
    </>
  );
}

interface HubLink { paired: boolean; hubUrl: string | null; store: { slug: string; name: string } | null; state: 'off' | 'not-paired' | 'connecting' | 'connected' | 'retrying'; lastError: string | null; accepting: boolean }

/** The order hub: the internet service that takes orders from the app and website and passes them to this POS. */
function HubCard({ isOwner }: { isOwner: boolean }) {
  const { api, notify, fail } = useSession();
  const [link, setLink] = useState<HubLink | null>(null);
  const [hubUrl, setHubUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const load = () => api.request<HubLink>('GET', `${BASE}/hub`).then(setLink).catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [api]);
  const pair = async () => {
    setBusy(true);
    try { const l = await api.request<HubLink>('POST', `${BASE}/hub/pair`, { hubUrl: hubUrl.trim(), code: code.trim().toUpperCase() }, newKey()); setLink(l); setCode(''); notify('success', `Connected to the order hub as ${l.store?.name ?? 'this store'}.`); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const unpair = async () => {
    setBusy(true);
    try { setLink(await api.request<HubLink>('DELETE', `${BASE}/hub`, undefined, newKey())); setConfirm(false); notify('success', 'Disconnected from the order hub. No more online orders arrive.'); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const status = !link ? 'Loading…' : link.state === 'connected' ? 'Connected: orders arrive live.' : link.state === 'retrying' ? `Cannot reach the hub, trying again. ${link.lastError ?? ''}` : link.state === 'connecting' ? 'Connecting…' : 'Not connected.';
  return (
    <section className="rounded-2xl border border-border bg-card p-4" aria-label="Order hub">
      <h3 className="mb-1 flex items-center gap-2 font-semibold"><Link2 className="h-4 w-4 text-primary" />Order hub</h3>
      <p className="mb-3 text-sm text-muted-foreground">The internet service that takes orders from your app and website and sends them to this POS straight away.</p>
      {link?.paired ? (
        <>
          <p className="text-sm"><b>{link.store?.name}</b> on {link.hubUrl}</p>
          <p className={`text-sm ${link.state === 'connected' ? 'text-veg' : 'text-destructive'}`}>{status}</p>
          {!link.accepting && <p className="mt-1 text-xs text-muted-foreground">Customers can order only while a shift is open.</p>}
          {isOwner && (confirm
            ? <div className="mt-3 flex gap-2"><button className="btn-primary bg-destructive" disabled={busy} onClick={() => void unpair()}>Yes, disconnect</button><button className="btn-ghost" onClick={() => setConfirm(false)}>Back</button></div>
            : <button className="btn-ghost mt-3" onClick={() => setConfirm(true)}>Disconnect</button>)}
        </>
      ) : isOwner ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
          <input className="field" placeholder="Hub address, e.g. https://orders.example.in" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} aria-label="Hub address" />
          <input className="field font-mono uppercase" placeholder="Pairing code" maxLength={9} value={code} onChange={(e) => setCode(e.target.value)} aria-label="Pairing code" />
          <button className="btn-primary" disabled={busy || !hubUrl.trim() || code.trim().length < 8} onClick={() => void pair()}>{busy ? 'Connecting…' : 'Connect'}</button>
          <p className="text-xs text-muted-foreground sm:col-span-3">Get the address and a pairing code from whoever runs your order hub. The code works once, for 30 minutes.</p>
        </div>
      ) : <p className="text-sm text-muted-foreground">Not connected. The owner connects the hub.</p>}
    </section>
  );
}
