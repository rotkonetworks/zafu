import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { isPayee, nameVerified, payLink } from './fees';
import { nameFrom, payableOffers } from './peer';
import type { Offer, PeerQuoteRow } from './fees';

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
    // wise and venmo hash a private account id: their names are taken as given
    expect(isPayee(offer('wise', 'account-id'), 'massimol67')).toBe(true);
  });

  it('borrows only a name that hashes to the payee, never over one peer gave', () => {
    const o = offer('revolut', 'bojaneuro');
    const names = (n: string) => new Map([[o.payeeDetails, n]]);
    expect(nameFrom(names('bojaneuro'))(o).handle).toBe('bojaneuro');
    expect(nameFrom(names('impostor'))(o).handle).toBe('');
    expect(nameFrom(names('bojaneuro'))({ ...o, handle: 'given' }).handle).toBe('given');
  });

  it('calls a name verified only where it hashes to the payee', () => {
    expect(nameVerified(offer('revolut', 'bojaneuro', 'bojaneuro'))).toBe(true);
    expect(nameVerified(offer('cashapp', 'ahtcinc', '$ahtcinc'))).toBe(true);
    expect(nameVerified(offer('wise', 'account-id', 'massimol67'))).toBe(false);
    expect(nameVerified(offer('revolut', 'bojaneuro'))).toBe(false);
  });

  it('links to the seller on their app', () => {
    expect(payLink('wise', 'massimol67')).toBe('https://wise.com/pay/me/massimol67');
    expect(payLink('cashapp', '$ahtcinc')).toBe('https://cash.app/$ahtcinc');
    expect(payLink('venmo', '@barry-blaha')).toBe('https://venmo.com/u/barry-blaha');
    expect(payLink('zelle', 'a@b.c')).toBeUndefined();
    expect(payLink('wise', '')).toBeUndefined();
  });
});

describe('sellers a buy can pay', () => {
  const row = (id: string, offchainId?: string): PeerQuoteRow => ({
    fiatAmount: '50000000',
    tokenAmount: '49000000',
    conversionRate: '1020000000000000000',
    intent: {
      depositId: id,
      payeeDetails: keccak256(toHex(id)),
      processorName: 'revolut',
      escrowAddress: '0x777777779d229cdF3110e9de47943791c26300Ef',
      fiatCurrencyCode: '0x',
    },
    ...(offchainId ? { maker: { offchainId } } : {}),
  });

  it('drops a seller peer left unnamed, since there is nobody to pay', () => {
    expect(payableOffers([row('a'), row('b')], new Map())).toEqual([]);
  });

  it('keeps a seller peer named, or one a checked name was found for', () => {
    const named = payableOffers([row('a', 'alice'), row('b')], new Map());
    expect(named.map(o => o.handle)).toEqual(['alice']);
    const borrowed = payableOffers([row('b')], new Map([[keccak256(toHex('b')), 'b']]));
    expect(borrowed.map(o => o.handle)).toEqual(['b']);
  });
});
