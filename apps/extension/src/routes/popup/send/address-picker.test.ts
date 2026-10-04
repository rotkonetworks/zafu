import { describe, expect, it } from 'vitest';
import type { Contact } from '../../../state/contacts';
import { pickerRows } from './send-fields';

const BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const BTC_OLD = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const UA = 'u1' + 'q'.repeat(100);
const ZID = 'ab'.repeat(32);

const contact = (id: string, addresses: Contact['addresses']): Contact => ({
  id,
  name: id,
  createdAt: 1,
  addresses,
});

const contacts: Contact[] = [
  contact('ann', [
    { id: 'a1', network: 'bitcoin', address: BTC, lastUsedAt: 1 },
    { id: 'a2', network: 'zcash', address: UA },
  ]),
  // saved before 5acc72df: a bitcoin address and a zid filed under zcash
  contact('bob', [
    { id: 'b1', network: 'zcash', address: BTC_OLD, lastUsedAt: 5 },
    { id: 'b2', network: 'zcash', address: ZID },
  ]),
  contact('cy', [{ id: 'c1', network: 'base', address: ETH }]),
];

describe('address picker rows', () => {
  it('show only that chain: yours first, then contacts', () => {
    const rows = pickerRows({
      chain: 'bitcoin',
      yours: [
        {
          label: 'your bitcoin',
          address: 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
        },
        { label: 'wrong', address: ETH },
      ],
      contacts,
    });
    expect(rows.yours.map(r => r.label)).toEqual(['your bitcoin']);
    // bob's old entry is a bitcoin address, so it is here, most recently used first
    expect(rows.contacts.map(r => r.address)).toEqual([BTC_OLD, BTC]);
  });

  it('never offer a misfiled address, or a zid, on zcash', () => {
    const rows = pickerRows({ chain: 'zcash', contacts });
    expect(rows.contacts.map(r => r.address)).toEqual([UA]);
  });

  it('keep an evm address to the chain it was saved on', () => {
    expect(pickerRows({ chain: 'base', contacts }).contacts.map(r => r.label)).toEqual(['cy']);
    expect(pickerRows({ chain: 'ethereum', contacts }).contacts).toEqual([]);
  });

  it('put favorites first, add recent payees, and show each address once', () => {
    const rows = pickerRows({
      chain: 'bitcoin',
      contacts,
      favoriteIds: new Set(['ann']),
      recent: [
        { address: BTC, network: 'bitcoin' },
        { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'bitcoin' },
        { address: ZID, network: 'bitcoin' },
      ],
    });
    expect(rows.contacts.map(r => r.label)).toEqual(['ann', 'bob', 'bc1qw5…8f3t4']);
  });

  it('search by name or address', () => {
    const rows = pickerRows({ chain: 'bitcoin', contacts, query: 'bo' });
    expect(rows.contacts.map(r => r.label)).toEqual(['bob']);
  });
});
