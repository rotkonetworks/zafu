import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./use-address', () => ({
  deriveZcashTransparent: (_m: string, pocket: number, i: number) =>
    Promise.resolve(`t1-${pocket}-${i}`),
  deriveZcashTransparentFromUfvk: (_u: string, i: number) => Promise.resolve(`t1-ufvk-${i}`),
}));

import { stampTSweepCutoff, T_SWEEP_BEFORE } from '../state/pocket-id';
import {
  claimSwapTAddress,
  lookBackTAddresses,
  sweepDue,
  nextSwapTAddressQuery,
  transparentAddressesQuery,
} from './use-transparent-addresses';

const source = {
  keyInfo: { id: 'w', type: 'mnemonic' },
  keyRing: { getMnemonic: () => Promise.resolve('seed') },
  watchOnly: undefined,
  pocket: 2,
  storeId: 'w#2',
  isZcash: true,
} as never;

const run = <T>(q: { queryFn?: unknown }) => (q.queryFn as () => Promise<T>)();

describe('a swap takes its own transparent address', () => {
  beforeEach(() => chrome.storage.local.clear());

  it('claims a fresh index each time, never the shown address, never twice', async () => {
    const [a, b] = await Promise.all([
      claimSwapTAddress(source, true),
      claimSwapTAddress(source, true),
    ]);
    expect(new Set([a.index, b.index])).toEqual(new Set([1, 2]));
    expect([a.address, b.address].sort()).toEqual(['t1-2-1', 't1-2-2']);
    expect(await chrome.storage.local.get('zcashTransparentIndex#2')).toEqual({
      'zcashTransparentIndex#2': 2,
    });
  });

  it('a look at the next address claims nothing', async () => {
    await claimSwapTAddress(source, true);
    const next = await run<{ index: number; address: string }>(nextSwapTAddressQuery(source, true));
    expect(next).toEqual({ index: 2, address: 't1-2-2' });
    expect(await run(nextSwapTAddressQuery(source, true))).toEqual(next);
  });

  it('every claimed address stays in the scan, past twenty too', async () => {
    for (let i = 0; i < 25; i++) {
      await claimSwapTAddress(source, true);
    }
    const { tAddresses } = await run<{ tAddresses: string[] }>(
      transparentAddressesQuery(source, true),
    );
    expect(tAddresses).toHaveLength(26);
    expect(tAddresses[0]).toBe('t1-2-0');
    expect(tAddresses[25]).toBe('t1-2-25');
  });
});

describe('a restored seed looks back once', () => {
  beforeEach(() => chrome.storage.local.clear());

  it('asks only index 0 until something is handed out', async () => {
    const { tAddresses } = await run<{ tAddresses: string[] }>(
      transparentAddressesQuery(source, true),
    );
    expect(tAddresses).toEqual(['t1-2-0']);
  });

  it('asks about the first twenty, then covers only up to the furthest with coins', async () => {
    const ask = vi.fn((older: string[]) => Promise.resolve([{ address: older[7]! }]));
    await lookBackTAddresses(source, true, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toHaveLength(20);
    const { tAddresses } = await run<{ tAddresses: string[] }>(
      transparentAddressesQuery(source, true),
    );
    expect(tAddresses).toHaveLength(8);
    expect(tAddresses[7]).toBe('t1-2-7');
  });

  it('finding nothing hands nothing out, and never lowers a swap claim', async () => {
    await lookBackTAddresses(source, true, () => Promise.resolve([]));
    expect(await chrome.storage.local.get('zcashTransparentIndex#2')).toEqual({});
    for (let i = 0; i < 25; i++) {
      await claimSwapTAddress(source, true);
    }
    await lookBackTAddresses(source, true, older => Promise.resolve([{ address: older[3]! }]));
    expect(await chrome.storage.local.get('zcashTransparentIndex#2')).toEqual({
      'zcashTransparentIndex#2': 25,
    });
  });
});

describe('a wallet from before the upgrade looks back once', () => {
  beforeEach(() => chrome.storage.local.clear());
  const made = (createdAt: number) =>
    ({ ...(source as object), keyInfo: { id: 'w', type: 'mnemonic', createdAt } }) as never;
  const tAddrs = async (src: never) =>
    (await run<{ tAddresses: string[] }>(transparentAddressesQuery(src, true))).tAddresses;

  it('an upgraded pocket at counter 0 finds coins at index 7, once', async () => {
    const old = made(1);
    // reading the cache first sets this storage up, as a real install already is
    expect(await tAddrs(old)).toEqual(['t1-2-0']);
    await stampTSweepCutoff('update');
    expect(await sweepDue(old)).toBe(true);

    const ask = vi.fn((older: string[]) => Promise.resolve([{ address: older[7]! }]));
    await lookBackTAddresses(old, true, ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await tAddrs(old)).toHaveLength(8);

    // the mark stops a second sweep
    expect(await sweepDue(old)).toBe(false);
  });

  it('a wallet made after the upgrade, or on a fresh install, never sweeps', async () => {
    await stampTSweepCutoff('update');
    expect(await sweepDue(made(1))).toBe(true);
    expect(await sweepDue(made(Date.now() + 1))).toBe(false);

    await chrome.storage.local.clear();
    await stampTSweepCutoff('install');
    // a later update keeps the install's cutoff
    await stampTSweepCutoff('update');
    expect(await chrome.storage.local.get(T_SWEEP_BEFORE)).toEqual({ [T_SWEEP_BEFORE]: 0 });
    expect(await sweepDue(made(1))).toBe(false);
  });
});
