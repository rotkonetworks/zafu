import { defineConfig } from 'vitest/config';

// pure crypto - no DOM, no chrome mocks needed.
export default defineConfig({ test: { environment: 'node' } });
