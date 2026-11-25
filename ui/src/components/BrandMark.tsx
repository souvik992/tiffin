/**
 * The quickPOS mark: the PosiNext sign (red square, white and navy arrows; red since 2026-11-25, as the DinePOS
 * screens), as in ui/public/favicon.svg and the app icon. `inverse`: a white square with a red arrow, for the red bar.
 */
export function BrandMark({ className = 'h-10 w-10', inverse = false }: { className?: string; inverse?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="quickPOS">
      <rect width="32" height="32" rx="7" fill={inverse ? '#ffffff' : '#d42a2f'} />
      <g transform="translate(4.48 7.36) scale(0.72)">
        <path d="M2 2 L12 12 L2 22 H8 L18 12 L8 2 Z" fill={inverse ? '#d42a2f' : '#ffffff'} />
        <path d="M14 2 L24 12 L14 22 H20 L30 12 L20 2 Z" fill="#0a1326" />
      </g>
    </svg>
  );
}
