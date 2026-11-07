import { describe, expect, it } from 'vitest';
import { Secp256k1, sha256, ripemd160 } from '@cosmjs/crypto';
import { toBech32, toHex } from '@cosmjs/encoding';
import { ZIGNER_KEY_MISMATCH, zignerKeyAddress } from './zigner-key';

// a throwaway key from a fixed, public test seed; it never holds funds
const keypair = await Secp256k1.makeKeypair(new Uint8Array(32).fill(7));
const pubkey = Secp256k1.compressPubkey(keypair.pubkey);
const hex = toHex(pubkey);
const osmo = toBech32('osmo', ripemd160(sha256(pubkey)));

const code = (addresses: unknown[]) =>
  JSON.stringify({ type: 'cosmos-accounts', version: 1, public_key: hex, addresses });

describe('zignerKeyAddress', () => {
  it('derives the address from a bare key', () => {
    expect(zignerKeyAddress(hex, 'osmo')).toEqual({ address: osmo });
    expect(zignerKeyAddress(`0x${hex.toUpperCase()}`, 'osmo')).toEqual({ address: osmo });
  });

  it('derives the address from a cosmos-accounts code', () => {
    expect(
      zignerKeyAddress(code([{ chain_id: 'osmosis-1', address: osmo, prefix: 'osmo' }]), 'osmo'),
    ).toEqual({ address: osmo });
  });

  it('derives for a prefix the code does not list', () => {
    const noble = toBech32('noble', ripemd160(sha256(pubkey)));
    expect(zignerKeyAddress(code([]), 'noble')).toEqual({ address: noble });
  });

  it('refuses a code whose listed address disagrees with its key', () => {
    const other = toBech32('osmo', new Uint8Array(20).fill(1));
    expect(
      zignerKeyAddress(code([{ chain_id: 'osmosis-1', address: other, prefix: 'osmo' }]), 'osmo'),
    ).toEqual({ address: '', refused: ZIGNER_KEY_MISMATCH });
  });

  it('leaves anything else to the address parser', () => {
    expect(zignerKeyAddress(osmo, 'osmo')).toBeUndefined();
    expect(zignerKeyAddress(hex.slice(2), 'osmo')).toBeUndefined();
    expect(zignerKeyAddress('{"type":"other","public_key":"' + hex + '"}', 'osmo')).toBeUndefined();
    expect(zignerKeyAddress('{not json', 'osmo')).toBeUndefined();
  });
});
