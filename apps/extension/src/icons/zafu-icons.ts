/**
 * zafu icon collection — hand-drawn Japanese-motif icons for UnoCSS.
 *
 * Registered as the `zafu` collection in uno.config.ts, used exactly like
 * lucide: `<span className='i-zafu-mon h-5 w-5' />`. Monochrome SVGs on a
 * 24-grid, stroke-based with round caps so they read as brush strokes and
 * inherit currentColor through UnoCSS's mask rendering.
 *
 * Motifs (each earns its meaning, nothing decorative):
 *   mon      — 文銭 coin with a square hole → home/wallet
 *   letter   — folded washi letter → inbox
 *   torii    — 鳥居 gate: many pillars carry one beam → multisig
 *   sensu    — 扇子 folding fan (raised to signal assent) → vote
 *   hanko    — 判子 seal → signing / zigner
 *   enso     — 円相 open brush circle → sync/loading
 *   shoji    — 障子 lattice → settings
 */
const S =
  'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const zafuIcons: Record<string, string> = {
  mon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <path d="M12 3.2 a8.8 8.8 0 1 0 8.6 6.9"/>
    <rect x="9.2" y="9.2" width="5.6" height="5.6"/>
  </svg>`,

  letter: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <path d="M3.5 6.5 h17 v11 h-17 z"/>
    <path d="M3.8 6.8 L12 12.6 L20.2 6.8"/>
    <path d="M7.5 17.2 L10.2 13.9 M16.5 17.2 L13.8 13.9"/>
  </svg>`,

  torii: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <path d="M2.8 5.6 C6 4.4 18 4.4 21.2 5.6"/>
    <path d="M4.6 8.9 h14.8"/>
    <path d="M6.5 5.4 L7.1 20.4 M17.5 5.4 L16.9 20.4"/>
    <path d="M12 5 v3.9"/>
  </svg>`,

  sensu: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <path d="M12 19.5 L4.2 8.2 A13.6 13.6 0 0 1 19.8 8.2 Z"/>
    <path d="M12 19.5 L9.1 6.3 M12 19.5 L14.9 6.3"/>
    <path d="M12 19.5 v1.6"/>
  </svg>`,

  hanko: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <g transform="rotate(-5 12 12)">
      <rect x="5" y="5" width="14" height="14" rx="2.4"/>
      <rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1"/>
    </g>
  </svg>`,

  enso: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <path d="M14.9 4.1 A8.8 8.8 0 1 0 19.4 8.3"/>
  </svg>`,

  shoji: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${S}>
    <rect x="4" y="3.5" width="16" height="17"/>
    <path d="M4 9.2 h16 M4 14.8 h16 M9.3 3.5 v17 M14.7 3.5 v17"/>
  </svg>`,
};
