import { defineConfig } from 'vitest/config';

// pure composition - no DOM, no chrome mocks needed.
export default defineConfig({ test: { environment: 'node' } });
