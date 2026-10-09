import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EgressTable } from './egress-table';

const calls: string[] = [];
let publish: (t: EgressTable) => void = () => undefined;
vi.mock('./egress', () => ({
  nymRoutingOn: () => Promise.resolve(true),
  onEgressTable: (l: (t: EgressTable) => void) => {
    publish = l;
    return () => undefined;
  },
}));
vi.mock('./nym-bridge', () => ({
  NYM_MAY_START: 'zafu_nym_may_start',
  ensureNym: () => Promise.resolve(void calls.push('start')),
  postNym: (m: { type: string; idle?: true }) => calls.push(m.idle ? `${m.type}-idle` : m.type),
}));

let session: Record<string, unknown> = {};
let changed: (c: Record<string, unknown>, area: string) => void = () => undefined;
type OnMessage = (m: unknown, s: { id?: string }, respond: (v: unknown) => void) => boolean;
const onMessage: OnMessage[] = [];
vi.stubGlobal('chrome', {
  runtime: { id: 'zafu', onMessage: { addListener: (l: OnMessage) => onMessage.push(l) } },
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

  it('kept ready turned off while up: the idle tunnel goes, then on demand', async () => {
    const nym = startNymLifecycle();
    await lock(true);
    publish(table({}));
    publish(table({ nymKeepReady: false }));
    expect(calls).toEqual(['start', 'stop-idle']);
    // back to on demand: nothing more until a window closes
    publish(table({ nymKeepReady: false }));
    nym.lastWindowClosed();
    expect(calls).toEqual(['start', 'stop-idle', 'stop']);
  });

  it('stops when nothing sends over nym any more', async () => {
    startNymLifecycle();
    await lock(true);
    publish(table({}));
    publish(table({ nymVia: [] }));
    expect(calls).toEqual(['start', 'stop']);
  });
});

describe('the plan answers every start the offscreen tunnel asks about', () => {
  const ask = () =>
    new Promise(respond =>
      onMessage.at(-1)!({ type: 'zafu_nym_may_start' }, { id: 'zafu' }, respond),
    );

  it('no while locked, yes once unlocked, no again on lock', async () => {
    startNymLifecycle();
    publish(table({ nymKeepReady: false }));
    session = {};
    expect(await ask()).toBe(false);
    session = { passwordKey: 'k' };
    expect(await ask()).toBe(true);
    session = {};
    expect(await ask()).toBe(false);
  });

  it('no when nym is off, whatever the lock', async () => {
    startNymLifecycle();
    session = { passwordKey: 'k' };
    publish(table({ nym: false }));
    expect(await ask()).toBe(false);
  });

  it('answers only zafu itself', () => {
    startNymLifecycle();
    expect(
      onMessage.at(-1)!({ type: 'zafu_nym_may_start' }, { id: 'other' }, () => undefined),
    ).toBe(false);
  });
});
