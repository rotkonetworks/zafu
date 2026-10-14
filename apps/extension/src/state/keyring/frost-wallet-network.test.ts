import { describe, expect, it } from 'vitest';
import { buildFrostZcashWallet, type FrostMultisigParams } from './vault-ops';

const params = (o: Partial<FrostMultisigParams> = {}): FrostMultisigParams => ({
  label: 'zkpoker-room',
  address: 'utest1group',
  orchardFvk: 'uviewtest1group',
  publicKeyPackage: '00',
  threshold: 2,
  maxSigners: 3,
  relayUrl: 'http://127.0.0.1:1',
  keyPackage: '00',
  ephemeralSeed: '00',
  ...o,
});

describe('a DKG-joined multisig keeps the network it was made for', () => {
  it('a testnet group is a testnet wallet', () => {
    // a poker escrow on testnet joins with network=test; flagged mainnet, its
    // payout review showed the escrow's outputs as u1… addresses
    expect(
      buildFrostZcashWallet(params({ mainnet: false }), 'v1', undefined, undefined).mainnet,
    ).toBe(false);
  });

  it('mainnet when the caller says nothing (every group made before)', () => {
    expect(buildFrostZcashWallet(params(), 'v1', undefined, undefined).mainnet).toBe(true);
  });
});
