// @vitest-environment node
/**
 * The service worker bundle reaches `clients.ts` (see `wallet-services.ts`), and
 * the worker has no `window`. A module-scope `window.addEventListener` here is
 * not a runtime-conditional hazard: it throws while webpack evaluates the
 * module, which aborts the *entire* worker boot - no message, alarm or connect
 * listener is ever installed. This test evaluates the module with no `window`,
 * exactly as the worker does.
 */
import { describe, expect, it } from 'vitest';

describe('clients module in a worker-like environment', () => {
  it('evaluates with no window present', async () => {
    expect(typeof globalThis.window).toBe('undefined');

    const mod = await import('./clients');

    expect(typeof mod.getOrCreatePort).toBe('function');
    expect(mod.viewClient).toBeDefined();
  });
});
