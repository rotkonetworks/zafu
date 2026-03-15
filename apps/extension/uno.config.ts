import { defineConfig } from 'unocss';
import presetIcons from '@unocss/preset-icons';

export default defineConfig({
  content: {
    pipeline: {
      include: [/\.tsx?$/],
      exclude: [/node_modules/, /\.wasm$/, /\.woff2?$/],
    },
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
