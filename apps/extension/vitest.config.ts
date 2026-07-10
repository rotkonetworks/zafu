import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // *.node.test.mjs files are `node --test` ports, not vitest suites
    exclude: [...configDefaults.exclude, '**/*.node.test.mjs'],
    poolOptions: {
      threads: {
        execArgv: ['--experimental-wasm-modules'],
      },
    },
    setupFiles: ['./tests-setup.ts'],
  },
});
