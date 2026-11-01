import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { isPayee } from './fees';
import { nameFrom } from './peer';
import type { Offer } from './fees';

const offer = (platform: string, id: string, handle = ''): Offer => ({
  depositId: '1',
  handle,
  payeeDetails: keccak256(toHex(id)),
  escrow: '0x777777779d229cdF3110e9de47943791c26300Ef',
  fiatCurrencyHash: '0x',
  platform,
  rate: 0n,
  fiat: 0n,
  gross: 0n,
  peerFee: 0n,
  peerBps: 0,
  zafuFee: 0n,
  net: 0n,
});

describe('seller names', () => {
  it('checks a name against the payee hash', () => {
    expect(isPayee(offer('revolut', 'bojaneuro'), 'bojaneuro')).toBe(true);
    expect(isPayee(offer('revolut', 'bojaneuro'), 'someoneelse')).toBe(false);
    expect(isPayee(offer('cashapp', 'ahtcinc'), '$ahtcinc')).toBe(true);
    expect(isPayee(offer('revolut', ''), '')).toBe(false);
  });

  it('borrows only a name that hashes to the payee, never over one peer gave', () => {
    const o = offer('revolut', 'bojaneuro');
    const names = (n: string) => new Map([[o.payeeDetails, n]]);
    expect(nameFrom(names('bojaneuro'))(o).handle).toBe('bojaneuro');
    expect(nameFrom(names('impostor'))(o).handle).toBe('');
    expect(nameFrom(names('bojaneuro'))({ ...o, handle: 'given' }).handle).toBe('given');
  });
});
