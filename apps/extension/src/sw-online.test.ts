import { describe, expect, it, vi } from 'vitest';

describe('the online listener', () => {
  it('is registered when the module loads, before anyone subscribes, and forwards', async () => {
    const add = vi.spyOn(globalThis, 'addEventListener');
    const { onOnline } = await import('./sw-online');
    expect(add.mock.calls.map(c => c[0])).toContain('online');
    const heard = vi.fn();
    const off = onOnline(heard);
    globalThis.dispatchEvent(new Event('online'));
    off();
    globalThis.dispatchEvent(new Event('online'));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('the service worker imports it among its first, sync imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sw = readFileSync(join(__dirname, 'service-worker.ts'), 'utf8');
    const imports = [...sw.matchAll(/^import\s+[^;]*?['"]([^'"]+)['"]/gm)].map(m => m[1]);
    expect(imports.slice(0, 3)).toContain('./sw-online');
  });
});
