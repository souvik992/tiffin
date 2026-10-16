import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, WifiOff } from 'lucide-react';
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
function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1"><p className="text-sm font-semibold">{title}</p><p className="text-xs text-muted-foreground">{hint}</p></div>
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
                  <Row key={c} title={CHANNEL_LABELS[c]} hint={HINTS[c]}>
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

        <p className="rounded-xl border border-border bg-background p-3 text-xs text-muted-foreground">
          Orders start arriving once the online order hub is connected (coming next). Swiggy and Zomato also need this store to be onboarded with them as an integration partner.
        </p>
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
