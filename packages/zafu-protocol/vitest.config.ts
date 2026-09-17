import { defineConfig } from 'vitest/config';

// pure types + constants - no DOM, no chrome mocks needed.
export default defineConfig({ test: { environment: 'node' } });
