/** The quickPOS mark: the PosiNext sign (orange square, white and navy arrows), as in ui/public/favicon.svg and the app icon. */
export function BrandMark({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="quickPOS">
      <rect width="32" height="32" rx="7" fill="#f15b00" />
      <g transform="translate(4.48 7.36) scale(0.72)">
        <path d="M2 2 L12 12 L2 22 H8 L18 12 L8 2 Z" fill="#ffffff" />
        <path d="M14 2 L24 12 L14 22 H20 L30 12 L20 2 Z" fill="#0a1326" />
      </g>
    </svg>
  );
}
