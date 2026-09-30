import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveZcashTransparentAddress } from '@repo/wallet/networks/zcash/derive';
import { isP2pkhOf, pocketWalletKeys, type PocketKeysCtor } from './pocket-keys';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('pocketWalletKeys', () => {
  const fake = (withExport: boolean) => {
    const built: string[] = [];
    const Ctor = vi.fn(function (this: { tag: string }, seed: string) {
      built.push(`ctor:${seed}`);
      this.tag = 'account-0';
    }) as unknown as PocketKeysCtor<{ tag: string }>;
    if (withExport) {
      Ctor.from_seed_phrase_account = (seed, account) => {
        built.push(`account:${seed}:${account}`);
        return { tag: `account-${account}` };
      };
    }
    return { Ctor, built };
  };

  test('account 0 is the historic constructor, untouched', () => {
    const { Ctor, built } = fake(true);
    expect(pocketWalletKeys(Ctor, SEED, 0).tag).toBe('account-0');
    expect(built).toEqual([`ctor:${SEED}`]);
  });

  test('a pocket derives its own account and never touches account 0', () => {
    const { Ctor, built } = fake(true);
    expect(pocketWalletKeys(Ctor, SEED, 2).tag).toBe('account-2');
    expect(built).toEqual([`account:${SEED}:2`]);
  });

  test('without the export a pocket fails loudly instead of scanning account 0', () => {
    const { Ctor, built } = fake(false);
    expect(() => pocketWalletKeys(Ctor, SEED, 1)).toThrow(/newer zafu-wasm/);
    expect(built).toEqual([]);
  });
});

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  WalletKeys: PocketKeysCtor<{ get_fvk_hex(): string; free(): void }>;
  derive_transparent_privkey(seed: string, account: number, index: number): string;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const tAddressOf = (privHex: string) => {
  const hash = ripemd160(sha256(secp256k1.getPublicKey(privHex, true)));
  const payload = new Uint8Array([0x1c, 0xb8, ...hash]);
  const full = new Uint8Array([...payload, ...sha256(sha256(payload)).slice(0, 4)]);
  let n = full.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
};

/** P2PKH lock of a t-address, decoded independently of the key */
const scriptOf = (tAddress: string) => {
  let n = [...tAddress].reduce((acc, c) => acc * 58n + BigInt(B58.indexOf(c)), 0n);
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // [2 version][20 hash][4 checksum]
  return new Uint8Array([0x76, 0xa9, 0x14, ...bytes.slice(2, 22), 0x88, 0xac]);
};

describe('with the real zafu-wasm', () => {
  let wasm: Wasm;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    // vitest runs from apps/extension
    const blob = resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm');
    wasm.initSync({ module: readFileSync(blob) });
  });

  test('account 0 keys are exactly the legacy WalletKeys', () => {
    const legacy = new wasm.WalletKeys(SEED);
    const zero = pocketWalletKeys(wasm.WalletKeys, SEED, 0);
    expect(zero.get_fvk_hex()).toBe(legacy.get_fvk_hex());
    legacy.free();
    zero.free();
  });

  test('pocket 1 is a different key, or refused on a blob that predates pockets', () => {
    if (!wasm.WalletKeys.from_seed_phrase_account) {
      expect(() => pocketWalletKeys(wasm.WalletKeys, SEED, 1)).toThrow(/newer zafu-wasm/);
      return;
    }
    const zero = pocketWalletKeys(wasm.WalletKeys, SEED, 0);
    const one = pocketWalletKeys(wasm.WalletKeys, SEED, 1);
    expect(one.get_fvk_hex()).not.toBe(zero.get_fvk_hex());
    zero.free();
    one.free();
  });

  test("each pocket's t-branch: the shield signing key controls the address shown", () => {
    const seen = new Set<string>();
    for (const account of [0, 1, 2]) {
      for (const index of [0, 3]) {
        const shown = deriveZcashTransparentAddress(SEED, account, index, true);
        expect(tAddressOf(wasm.derive_transparent_privkey(SEED, account, index))).toBe(shown);
        seen.add(shown);
      }
    }
    expect(seen.size).toBe(6);
  });

  test("shielding accepts only inputs locked to the pocket's own key", () => {
    const script = scriptOf(deriveZcashTransparentAddress(SEED, 1, 3, true));
    expect(isP2pkhOf(script, wasm.derive_transparent_privkey(SEED, 1, 3))).toBe(true);
    // pocket 0 (or another index) can never sign pocket 1's coins
    expect(isP2pkhOf(script, wasm.derive_transparent_privkey(SEED, 0, 3))).toBe(false);
    expect(isP2pkhOf(script, wasm.derive_transparent_privkey(SEED, 1, 0))).toBe(false);
    expect(isP2pkhOf(new Uint8Array(0), wasm.derive_transparent_privkey(SEED, 1, 3))).toBe(false);
  });
});
