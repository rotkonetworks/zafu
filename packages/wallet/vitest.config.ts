import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    poolOptions: {
      threads: {
        execArgv: ['--experimental-wasm-modules'],
      },
    },
    setupFiles: ['./tests-setup.ts'],
    // `*.node.test.mjs` files are intended for Node's native test runner
    // (`node --test`) and don't tolerate vitest's jsdom + navigator.locks
    // setup. Exclude from vitest discovery; run separately via
    // `pnpm exec node --test packages/wallet/src/*.node.test.mjs`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.node.test.mjs'],
  },
});
