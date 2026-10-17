import { Globe, Smartphone } from 'lucide-react';

/** Where an online order came from, as a badge in the channel's own colours: Swiggy, Zomato, the store's website or app. */
export type Channel = 'app' | 'website' | 'swiggy' | 'zomato';

const LOOK: Record<Channel, { label: string; cls: string }> = {
  swiggy: { label: 'Swiggy', cls: 'bg-[#FC8019] text-white font-extrabold tracking-tight' },
  zomato: { label: 'zomato', cls: 'bg-[#E23744] text-white font-extrabold italic tracking-tight lowercase' },
  website: { label: 'Website', cls: 'bg-accent text-primary font-semibold' },
  app: { label: 'App', cls: 'bg-accent text-primary font-semibold' },
};

export function ChannelBadge({ channel, size = 'sm' }: { channel: string; size?: 'sm' | 'md' }) {
  const c = (channel ?? '').toLowerCase() as Channel;
  const look = LOOK[c] ?? { label: channel, cls: 'bg-muted font-semibold' };
  const pad = size === 'md' ? 'h-7 px-3 text-sm' : 'h-6 px-2.5 text-xs';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md ${pad} ${look.cls}`} title={`Order from ${look.label}`} aria-label={`From ${look.label}`}>
      {c === 'website' && <Globe className="h-3.5 w-3.5" />}
      {c === 'app' && <Smartphone className="h-3.5 w-3.5" />}
      {look.label}
    </span>
  );
}
