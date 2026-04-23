import { defineConfig } from 'unocss';
import presetIcons from '@unocss/preset-icons';

/**
 * UnoCSS theme mirrors the v2 design-system tokens defined in
 * packages/ui/styles/globals.css. Utilities like `bg-fg`, `text-fg-dim`,
 * `border-surface-border`, `bg-zigner-gold` compile directly to
 * var(--fg), var(--fg-dim), etc — single source of truth.
 */
export default defineConfig({
  content: {
    filesystem: [
      'src/**/*.{ts,tsx}',
      '../../packages/ui/**/*.{ts,tsx}',
    ],
  },
  presets: [
    presetIcons({
      scale: 1,
      prefix: 'i-',
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  theme: {
    colors: {
      // ink
      fg: 'var(--fg)',
      'fg-high': 'var(--fg-high)',
      'fg-muted': 'var(--fg-muted)',
      'fg-dim': 'var(--fg-dim)',

      // surfaces
      canvas: 'var(--surface-canvas)',
      'elev-1': 'var(--surface-elev-1)',
      'elev-2': 'var(--surface-elev-2)',
      'border-soft': 'var(--surface-border-soft)',
      'border-hard': 'var(--surface-border)',

      // brand — gold
      'zigner-gold': 'var(--zigner-gold)',
      'zigner-gold-dark': 'var(--zigner-gold-dark)',
      'zigner-gold-light': 'var(--zigner-gold-light)',
      'zigner-dark': 'var(--zigner-dark)',

      // brand — blue
      'zafu-blue': 'var(--zafu-blue)',
      'zafu-blue-dark': 'var(--zafu-blue-dark)',
      'zafu-blue-light': 'var(--zafu-blue-light)',

      // network-aware (rebinds per [data-network])
      'network-accent': 'var(--network-accent)',
      'network-accent-light': 'var(--network-accent-light)',
      'network-accent-fg': 'var(--network-accent-foreground)',

      // semantic status
      success: 'var(--success)',
      warning: 'var(--warning)',
      error: 'var(--error)',
      info: 'var(--info)',
    },
    spacing: {
      // token-aligned scale — matches --space-* in globals.css
      1: 'var(--space-1)',   // 4
      2: 'var(--space-2)',   // 8
      3: 'var(--space-3)',   // 12
      4: 'var(--space-4)',   // 16
      5: 'var(--space-5)',   // 20
      6: 'var(--space-6)',   // 24
      8: 'var(--space-8)',   // 32
      12: 'var(--space-12)', // 48
    },
    borderRadius: {
      none: 'var(--radius-sharp)',
      sm: 'var(--radius-sm)',
      DEFAULT: 'var(--radius-md)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      full: 'var(--radius-pill)',
    },
    fontFamily: {
      mono: 'var(--font-mono)',
    },
  },
  shortcuts: {
    // editorial labels: dim lowercase kicker above masthead
    kicker: 'text-[10px] text-fg-dim uppercase tracking-[0.2em]',
    // small labels above rule / inside section-head
    'section-label': 'text-[11px] text-fg-high lowercase tracking-[0.04em]',
    // numeric monospace (addresses, amounts, timestamps)
    tabular: 'font-mono tabular-nums tracking-[-0.005em]',
    // hairline rule used across masthead / section-head / ruler
    rule: 'h-px bg-border-hard',
  },
});
