import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./use-address', () => ({
  deriveZcashTransparent: (_m: string, pocket: number, i: number) =>
    Promise.resolve(`t1-${pocket}-${i}`),
  deriveZcashTransparentFromUfvk: (_u: string, i: number) => Promise.resolve(`t1-ufvk-${i}`),
}));

import {
  claimSwapTAddress,
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

  it('every claimed address stays in the scan, past the legacy floor too', async () => {
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
