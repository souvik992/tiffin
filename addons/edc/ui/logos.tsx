import type { Provider } from './host.ts';

// The companies' names drawn in their brand colours, standing in for their official logo files (trademarks we do not
// ship; replace these with the files from Paytm's and Pine Labs' partner kits when they are provided).

export function PaytmLogo({ className = 'h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 30" className={className} role="img" aria-label="Paytm">
      <text x="0" y="23" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="26" letterSpacing="-0.5">
        <tspan fill="#002E6E">pay</tspan><tspan fill="#00BAF2">tm</tspan>
      </text>
    </svg>
  );
}

export function PineLabsLogo({ className = 'h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 132 30" className={className} role="img" aria-label="Pine Labs">
      {/* a small pine mark, then the name */}
      <path d="M12 2 L21 14 H16 L23 24 H1 L8 14 H3 Z" fill="#0F9D58" />
      <rect x="10.5" y="24" width="3" height="5" rx="1" fill="#0B6E3E" />
      <text x="28" y="22" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="20">
        <tspan fill="#1F2A44">pine</tspan><tspan fill="#0F9D58"> labs</tspan>
      </text>
    </svg>
  );
}

export function ProviderLogo({ provider, className }: { provider: Provider; className?: string }) {
  return provider === 'paytm' ? <PaytmLogo className={className} /> : <PineLabsLogo className={className} />;
}
