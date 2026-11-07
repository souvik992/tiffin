import { Globe, Smartphone } from 'lucide-react';

/** Where an online order came from, as a logo and name in the channel's own colours: Swiggy, Zomato, the store's website or app. */
export type Channel = 'app' | 'website' | 'swiggy' | 'zomato';

const LOOK: Record<Channel, { label: string; tile: string; text: string }> = {
  swiggy: { label: 'Swiggy', tile: 'bg-[#FC8019] text-white', text: 'text-[#C2410C] font-extrabold tracking-tight' },
  zomato: { label: 'zomato', tile: 'bg-[#E23744] text-white', text: 'text-[#CB202D] font-extrabold italic tracking-tight lowercase' },
  website: { label: 'Website', tile: 'bg-[#2563EB] text-white', text: 'text-[#1D4ED8] font-semibold' },
  app: { label: 'App', tile: 'bg-[#7C3AED] text-white', text: 'text-[#6D28D9] font-semibold' },
};

/** The channel's logo mark: a rounded tile in its colour. Drawn here (no image files), so it works offline and prints sharp at any size. */
export function ChannelLogo({ channel, px = 24 }: { channel: string; px?: number }) {
  const c = (channel ?? '').toLowerCase() as Channel;
  const look = LOOK[c];
  const box = { width: px, height: px };
  if (!look) return <span className="inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-xs font-bold" style={box} aria-hidden="true">{(channel ?? '?').slice(0, 1).toUpperCase()}</span>;
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-md ${look.tile}`} style={box} aria-hidden="true">
      {c === 'swiggy' && (
        // a location pin with an S cut out: Swiggy's look, in its orange
        <svg viewBox="0 0 24 24" width={px * 0.72} height={px * 0.72}>
          <path fill="currentColor" d="M12 2.2c-4.2 0-7.4 3.1-7.4 7.2 0 4.6 5.1 10.3 6.6 11.9.4.4 1.1.4 1.5 0 1.5-1.6 6.7-7.3 6.7-11.9 0-4.1-3.2-7.2-7.4-7.2z" />
          <text x="12" y="13.6" textAnchor="middle" fontSize="10" fontWeight="900" fontFamily="Arial, Helvetica, sans-serif" fill="#FC8019">S</text>
        </svg>
      )}
      {c === 'zomato' && (
        <svg viewBox="0 0 24 24" width={px * 0.8} height={px * 0.8}>
          <text x="12" y="17.5" textAnchor="middle" fontSize="19" fontWeight="900" fontStyle="italic" fontFamily="Arial, Helvetica, sans-serif" fill="currentColor">z</text>
        </svg>
      )}
      {c === 'website' && <Globe style={{ width: px * 0.62, height: px * 0.62 }} strokeWidth={2.4} />}
      {c === 'app' && <Smartphone style={{ width: px * 0.62, height: px * 0.62 }} strokeWidth={2.4} />}
    </span>
  );
}

/** The coloured left edge of an order card, so Swiggy, Zomato, website and app orders tell apart at a glance. */
export function channelStripe(channel: string): string {
  const c = (channel ?? '').toLowerCase();
  return c === 'swiggy' ? 'border-l-[#FC8019]' : c === 'zomato' ? 'border-l-[#E23744]' : c === 'website' ? 'border-l-[#2563EB]' : c === 'app' ? 'border-l-[#7C3AED]' : '';
}

/** Logo and name, e.g. on an order card. sm: lists and headers; md: the order card. */
export function ChannelBadge({ channel, size = 'sm' }: { channel: string; size?: 'sm' | 'md' }) {
  const c = (channel ?? '').toLowerCase() as Channel;
  const look = LOOK[c];
  const label = look?.label ?? channel;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 ${size === 'md' ? 'text-base' : 'text-sm'}`} title={`Order from ${label}`} aria-label={`From ${label}`}>
      <ChannelLogo channel={channel} px={size === 'md' ? 28 : 20} />
      <span className={look?.text ?? 'font-semibold'}>{label}</span>
    </span>
  );
}
