import { CheckCircle2, ChefHat, Inbox } from 'lucide-react';
import { host } from './host.ts';
import { CHANNEL_LABELS, useOnlineConfig } from './online.ts';
import type { OnlineConfig } from './online.ts';

const { PageShell } = host;

const COLUMNS = [
  { title: 'New', hint: 'Accept with a preparation time, or reject.', icon: Inbox },
  { title: 'Preparing', hint: 'Accepted: the bill and kitchen ticket are made.', icon: ChefHat },
  { title: 'Ready', hint: 'Waiting for pickup or the delivery rider.', icon: CheckCircle2 },
];

/** ODS: online orders from the enabled sales channels, by stage. Orders arrive once the order hub (step 1) is connected. */
export function Ods() {
  const online = useOnlineConfig();
  const channels = online ? (Object.keys(CHANNEL_LABELS) as Array<keyof OnlineConfig['channels']>).filter((c) => online.channels[c]).map((c) => CHANNEL_LABELS[c]) : [];
  return (
    <PageShell route="ods" title="ODS" subtitle="Online orders by stage.">
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Taking orders from:</span>
        {channels.map((c) => <span key={c} className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-primary">{c}</span>)}
      </div>
      <div className="mb-4 rounded-xl border border-border bg-card p-3 text-sm">
        <b>Not connected yet.</b> The online order hub is being built next. Until then no online orders arrive here; counter billing is not affected.
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map(({ title, hint, icon: Icon }) => (
          <section key={title} className="min-h-[50vh] rounded-2xl border border-border bg-card p-3" aria-label={title}>
            <h2 className="flex items-center gap-2 font-semibold"><Icon className="h-4 w-4 text-primary" />{title} <span className="ml-auto rounded-full bg-muted px-2 text-xs">0</span></h2>
            <p className="mb-6 text-xs text-muted-foreground">{hint}</p>
            <p className="text-center text-sm text-muted-foreground">No orders.</p>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
