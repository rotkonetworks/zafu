import { defineConfig } from 'unocss';
import presetIcons from '@unocss/preset-icons';
import { zafuIcons } from './src/icons/zafu-icons';

/**
 * UnoCSS in this project generates icon classes only (e.g. `i-lucide-home`).
 * Utility classes (text-fg, bg-elev-1, kicker, ...) come from Tailwind v4 —
 * see packages/tailwind-config/index.css for the @theme + @utility blocks
 * that define the v2 design-system surface.
 */
export default defineConfig({
  content: {
    filesystem: ['src/**/*.{ts,tsx}', '../../packages/ui/**/*.{ts,tsx}'],
  },
  presets: [
    presetIcons({
      scale: 1,
      prefix: 'i-',
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle',
      },
      // hand-drawn japanese-motif set — see src/icons/zafu-icons.ts
      collections: {
        zafu: zafuIcons,
      },
    }),
  ],
});
