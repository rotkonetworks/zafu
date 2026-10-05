import { describe, expect, it } from 'vitest';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { stringToPath } from '@cosmjs/crypto';
import {
  deriveThorAddress,
  deriveThorKey,
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
