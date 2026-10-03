import { describe, expect, it } from 'vitest';
import { addressKind, addressLabel, isRealAddress, refusalOf } from './address-kind';

const UA = 'u1' + 'q'.repeat(100);
const PEN = 'penumbra1' + 'q'.repeat(130);
const ZID = 'ab'.repeat(32);

describe('addressKind', () => {
  it('tells zcash pools, penumbra and a zid apart', () => {
    expect(addressKind(UA)).toEqual({ kind: 'zcash', pool: 'shielded' });
    expect(addressKind('t1' + 'a'.repeat(33))).toEqual({ kind: 'zcash', pool: 'transparent' });
    expect(addressKind(PEN)).toEqual({ kind: 'penumbra' });
    expect(addressKind(ZID)).toEqual({ kind: 'zid' });
    expect(addressKind('osmo1abc')).toEqual({ kind: 'unknown' });
  });
  it('refuses a zid and anything unknown, calmly', () => {
    expect(refusalOf(ZID)).toMatch(/identity, not an address/);
    expect(refusalOf('hello')).toMatch(/cannot pay this/);
    expect(refusalOf(UA)).toBeUndefined();
  });
  it('spots a stored entry that is not what its network says', () => {
    expect(isRealAddress({ id: '1', network: 'zcash', address: ZID })).toBe(false);
    expect(isRealAddress({ id: '2', network: 'zcash', address: PEN })).toBe(false);
    expect(isRealAddress({ id: '3', network: 'zcash', address: UA })).toBe(true);
    expect(addressLabel(UA)).toBe('zcash · shielded');
  });
});
