import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressTable } from './egress-table';

const calls: string[] = [];
let publish: (t: EgressTable) => void = () => undefined;
vi.mock('./egress', () => ({
  onEgressTable: (l: (t: EgressTable) => void) => {
    publish = l;
    return () => undefined;
  },
}));
vi.mock('./nym-bridge', () => ({
  ensureNym: () => Promise.resolve(void calls.push('start')),
  postNym: (m: { type: string }) => calls.push(m.type),
}));

let session: Record<string, unknown> = {};
let changed: (c: Record<string, unknown>, area: string) => void = () => undefined;
vi.stubGlobal('chrome', {
  storage: {
    session: { get: () => Promise.resolve(session) },
    onChanged: { addListener: (l: typeof changed) => (changed = l) },
  },
});

const { startNymLifecycle } = await import('./nym-lifecycle');
const table = (t: Partial<EgressTable>): EgressTable => ({
  rules: [],
  hosts: {},
  adhoc: false,
  nym: true,
  nymVia: ['zcash'],
  nymKeepReady: true,
  ...t,
});
const settle = () => new Promise(r => setTimeout(r, 0));
const lock = async (unlocked: boolean) => {
  session = unlocked ? { passwordKey: 'k' } : {};
  changed({ passwordKey: {} }, 'session');
  await settle();
};

describe('the nym lifecycle at the edge', () => {
  beforeEach(() => {
    calls.length = 0;
    session = {};
  });

  it('kept ready: up on unlock, kept through a closed window, down on lock', async () => {
    const nym = startNymLifecycle();
    publish(table({}));
    await settle();
    expect(calls).toEqual(['stop']);
    await lock(true);
    expect(calls).toEqual(['stop', 'start']);
    nym.lastWindowClosed();
    expect(calls).toEqual(['stop', 'start']);
    await lock(false);
    expect(calls).toEqual(['stop', 'start', 'stop']);
  });

  it('on demand: starts nothing, stops with the last window', async () => {
    const nym = startNymLifecycle();
    await lock(true);
    publish(table({ nymKeepReady: false }));
    expect(calls).toEqual([]);
    nym.lastWindowClosed();
    expect(calls).toEqual(['stop']);
  });

  it('stops when nothing sends over nym any more', async () => {
    startNymLifecycle();
    await lock(true);
    publish(table({}));
    publish(table({ nymVia: [] }));
    expect(calls).toEqual(['start', 'stop']);
  });
});
