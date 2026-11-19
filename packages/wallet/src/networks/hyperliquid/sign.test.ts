import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';
import { signUserAction, userActionDigest, type UserAction } from './sign';

/**
 * The official python sdk's own vectors: hyperliquid-dex/hyperliquid-python-sdk
 * tests/signing_test.py (test_sign_usd_transfer_action,
 * test_sign_withdraw_from_bridge_action) at commit 2fdb18f9. The sdk signs
 * with signatureChainId 0x66eee; `False` there is testnet.
 */
const SDK_KEY = hexToBytes('0123456789012345678901234567890123456789012345678901234567890123');
const message = {
  hyperliquidChain: 'Testnet',
  signatureChainId: '0x66eee',
  destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a',
  amount: '1',
  time: 1687816341423,
} as const;

describe('hyperliquid user-signed actions', () => {
  it('matches the sdk vector for a usd send, byte for byte', () => {
    expect(signUserAction(SDK_KEY, { ...message, type: 'usdSend' })).toEqual({
      r: '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073',
      s: '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7',
      v: 27,
    });
  });

  it('matches the sdk vector for a withdraw, byte for byte', () => {
    expect(signUserAction(SDK_KEY, { ...message, type: 'withdraw3' })).toEqual({
      r: '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9',
      s: '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881',
      v: 28,
    });
  });

  // the sdk publishes no spot-send vector: this proves only that the token is
  // signed and that the signature recovers to the signing key
  it('signs a spot send over its token, recoverable to the key', () => {
    const action: UserAction = {
      ...message,
      type: 'spotSend',
      token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
    };
    const digest = userActionDigest(action);
    expect(digest).not.toEqual(userActionDigest({ ...action, token: 'PURR:0x00' }));
    const { r, s, v } = signUserAction(SDK_KEY, action);
    const recovered = new secp256k1.Signature(BigInt(r), BigInt(s))
      .addRecoveryBit(v - 27)
      .recoverPublicKey(digest)
      .toHex(true);
    expect(recovered).toBe(Buffer.from(secp256k1.getPublicKey(SDK_KEY, true)).toString('hex'));
  });

  it('binds the signature to the chain, the destination, the amount and the time', () => {
    const base = userActionDigest({ ...message, type: 'usdSend' });
    const changed: Partial<typeof message>[] = [
      { hyperliquidChain: 'Mainnet' } as never,
      { signatureChainId: '0xa4b1' } as never,
      { destination: '0x0000000000000000000000000000000000000001' } as never,
      { amount: '2' } as never,
      { time: 1687816341424 } as never,
    ];
    for (const c of changed) {
      expect(userActionDigest({ ...message, ...c, type: 'usdSend' })).not.toEqual(base);
    }
  });
});
