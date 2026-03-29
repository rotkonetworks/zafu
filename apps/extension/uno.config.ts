import { defineConfig } from 'unocss';
import presetIcons from '@unocss/preset-icons';

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
});
