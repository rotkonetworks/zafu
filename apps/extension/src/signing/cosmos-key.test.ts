import { describe, expect, it } from 'vitest';
import { cosmosKeyFor, noCosmosKey } from './cosmos-key';

const zigner = (cosmosAddresses?: { chainId: string; address: string }[]) => ({
  id: 'z',
  type: 'zigner-zafu',
  insensitive: { coldSignerType: 'zigner', ...(cosmosAddresses ? { cosmosAddresses } : {}) },
});
const NOBLE = { chainId: 'noble', address: 'noble1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' };

describe('cosmosKeyFor', () => {
  it('a phrase wallet signs with its own key', () => {
    const key = { id: 'm', type: 'mnemonic', insensitive: {} };
    expect(cosmosKeyFor(key, 'noble')).toEqual({ signer: 'hot', key });
  });

  it('a zigner signs with the address it exported for the chain', () => {
    const key = zigner([NOBLE]);
    expect(cosmosKeyFor(key, 'noble')).toEqual({
      signer: 'zigner',
      key,
      address: NOBLE.address,
    });
  });

  it.each([
    ['a zigner that exported no cosmos key', zigner(), 'noble'],
    ['a zigner on an ethermint chain', zigner([NOBLE]), 'injective'],
    [
      'a keystone',
      { id: 'k', type: 'zigner-zafu', insensitive: { coldSignerType: 'keystone' } },
      'noble',
    ],
    [
      'a viewing key',
      { id: 'v', type: 'zigner-zafu', insensitive: { coldSignerType: 'viewing-key' } },
      'noble',
    ],
    ['no wallet at all', undefined, 'noble'],
  ] as const)('has no key for %s', (_, key, chain) => {
    expect(cosmosKeyFor(key, chain)).toBeNull();
  });

  it('refuses calmly, naming the chain', () => {
    expect(noCosmosKey('noble')).toBe(
      'this wallet has no key for noble · add one or pick a wallet that has it',
    );
  });
});
