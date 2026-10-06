import { describe, expect, it } from 'vitest';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { stringToPath } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import {
  deriveThorAddress,
  deriveThorKey,
  deriveThorKeyFromFvk,
  randomThorKeyHex,
  thorKeyFromHex,
  isThorAddress,
  thorAccountBytes,
  thorPath,
} from './derive';

// THORNode's mocknet/stagenet "dog" account (build/scripts/genesis.sh funds
// tthor1zf3gsk7edzwl9syyefvfhle37cjtql35h6k85m "# dog"; tools/stagenet's faucet
// is sthor1zf3gsk7edzwl9syyefvfhle37cjtql3585mpmq), on THORChainHDPath m/44'/931'/0'/0/0.
const DOG = `${'dog '.repeat(23)}fossil`;

describe('thorchain derivation', () => {
  it("matches THORNode's own dog account on every network prefix", () => {
    expect(deriveThorKey(DOG, 0, 'tthor').address).toBe(
      'tthor1zf3gsk7edzwl9syyefvfhle37cjtql35h6k85m',
    );
    expect(deriveThorKey(DOG, 0, 'sthor').address).toBe(
      'sthor1zf3gsk7edzwl9syyefvfhle37cjtql3585mpmq',
    );
    expect(deriveThorAddress(DOG, 0)).toBe('thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd7');
  });

  it('agrees with cosmjs on an explicit 931 path at other indices', async () => {
    for (const i of [1, 7, 42]) {
      const w = await Secp256k1HdWallet.fromMnemonic(DOG, {
        prefix: 'thor',
        hdPaths: [stringToPath(`m/44'/931'/0'/0/${i}`)],
      });
      expect(deriveThorAddress(DOG, i)).toBe((await w.getAccounts())[0]!.address);
    }
  });

  it('is not the coin-118 address (the fallback a missing chain row would give)', async () => {
    const w = await Secp256k1HdWallet.fromMnemonic(DOG, {
      prefix: 'thor',
      hdPaths: [stringToPath("m/44'/118'/0'/0/0")],
    });
    expect((await w.getAccounts())[0]!.address).not.toBe(deriveThorAddress(DOG, 0));
  });

  it('refuses a bad index and checks addresses', () => {
    expect(() => thorPath(-1)).toThrow();
    expect(() => thorPath(0x80000000)).toThrow();
    expect(isThorAddress('thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd7')).toBe(true);
    expect(isThorAddress('thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd8')).toBe(false);
    expect(isThorAddress('tthor1zf3gsk7edzwl9syyefvfhle37cjtql35h6k85m')).toBe(false);
    expect(() => thorAccountBytes('cosmos1zf3gsk7edzwl9syyefvfhle37cjtql35kkd9s6')).toThrow();
  });
});

// reproduced independently in Python (hashlib/hmac HKDF, plain secp256k1 and bech32):
// scratchpad fvk_vector.py, the spec in derive.ts deriveThorKeyFromFvk
const FVK = 'uview1zafuthorchainvectorfixedviewingkeystring0000';

describe('a rune key from a viewing key', () => {
  it('matches the independent vectors', () => {
    const k1 = deriveThorKeyFromFvk(FVK, 1);
    expect(toHex(k1.privateKey)).toBe(
      'f3aa2f28ea872f1c4eea93989966580b6b3d0f6b1ae3c097730d163a5e7b93c2',
    );
    expect(k1.address).toBe('thor1kvnh2vqzpfwr2g3w0wtex5mtx52rfk2lq5fscq');
    expect(deriveThorKeyFromFvk(FVK, 2).address).toBe(
      'thor16ppypm7zt53fvzaa0je59l299nzz7hp2ljdq3s',
    );
    expect(deriveThorKeyFromFvk(`${FVK.slice(0, -1)}q`, 1).address).toBe(
      'thor1kzm3ugypsyme8775tkzx0f4q6l9fwj0424eynd',
    );
  });

  it('is never the seed key and refuses an empty viewing key', () => {
    expect(deriveThorKeyFromFvk(FVK, 0).address).not.toBe(deriveThorAddress(DOG, 0));
    expect(() => deriveThorKeyFromFvk('', 1)).toThrow();
    expect(() => deriveThorKeyFromFvk(FVK, -1)).toThrow();
  });
});

describe('a random rune key', () => {
  it('is 32 fresh bytes each time, and the same hex always gives the same address', () => {
    const a = randomThorKeyHex();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(randomThorKeyHex()).not.toBe(a);
    expect(thorKeyFromHex(a).address).toBe(thorKeyFromHex(a).address);
    expect(isThorAddress(thorKeyFromHex(a).address)).toBe(true);
    expect(() => thorKeyFromHex('00'.repeat(32))).toThrow();
    expect(() => thorKeyFromHex('xyz')).toThrow();
  });
});
