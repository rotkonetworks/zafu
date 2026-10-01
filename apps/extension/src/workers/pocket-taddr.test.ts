// A pocket shows one t-address (index 0), but older builds rotated through
// more. Coins on those legacy indices must still be counted and shielded, by
// the pocket they belong to and no other.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { deriveZcashTransparentAddress } from '@repo/wallet/networks/zcash/derive';
import { pocketTransparentIndices } from '../state/pocket-id';
import { isP2pkhOf, tIndexOf, utxosByTIndex } from './pocket-keys';
import type { SpendKeysCtor } from './hot-sign';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: SpendKeysCtor & (new (...a: never[]) => { ufvk(): string });
  transparent_address_from_ufvk(ufvk: string, index: number): string;
  transparent_pubkey_from_ufvk(ufvk: string, index: number): string;
}

/** what use-transparent-addresses derives for a pocket, given its stored legacy max */
const pocketAddresses = (account: number, legacyMax: unknown) =>
  pocketTransparentIndices(legacyMax).map(i =>
    deriveZcashTransparentAddress(SEED, account, i, true),
  );

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** P2PKH lock of a t-address, decoded independently of the key */
const scriptOf = (tAddress: string) => {
  let n = [...tAddress].reduce((acc, c) => acc * 58n + BigInt(B58.indexOf(c)), 0n);
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([0x76, 0xa9, 0x14, ...bytes.slice(2, 22), 0x88, 0xac]);
};

const legacy3 = deriveZcashTransparentAddress(SEED, 0, 3, true);
const utxo = { address: legacy3, script: scriptOf(legacy3), valueZat: 50_000n };

describe('pocket transparent scan indices', () => {
  test('index 0 always, the old five-address floor, and any higher index once stored', () => {
    expect(pocketTransparentIndices(undefined)).toEqual([0, 1, 2, 3, 4]);
    expect(pocketTransparentIndices(3)).toEqual([0, 1, 2, 3, 4]);
    expect(pocketTransparentIndices(7)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pocketTransparentIndices('7')).toEqual([0, 1, 2, 3, 4]);
    expect(pocketTransparentIndices(-2)).toEqual([0, 1, 2, 3, 4]);
  });

  test('position is the derivation index', () => {
    const addrs = pocketAddresses(0, 9);
    addrs.forEach((a, i) => expect(a).toBe(deriveZcashTransparentAddress(SEED, 0, i, true)));
  });
});

describe('a UTXO on legacy index 3 of pocket 0', () => {
  test('is in the pocket 0 scan, so the balance counts it', () => {
    const scanned = pocketAddresses(0, undefined);
    expect(scanned[3]).toBe(legacy3);
    // the server answers only for the addresses asked about
    const reply = [utxo].filter(u => scanned.includes(u.address));
    expect(reply.reduce((s, u) => s + u.valueZat, 0n)).toBe(50_000n);
  });

  test('pocket 1 never asks about, or sees, any pocket 0 address', () => {
    const zero = pocketAddresses(0, 12);
    const one = pocketAddresses(1, 12);
    expect(one.filter(a => zero.includes(a))).toEqual([]);
    expect([utxo].filter(u => one.includes(u.address))).toEqual([]);
  });

  test('groups under index 3 for signing', () => {
    const groups = utxosByTIndex([utxo], pocketAddresses(0, undefined));
    expect([...groups.keys()]).toEqual([3]);
    expect(groups.get(3)).toEqual([utxo]);
  });

  describe('with the real zafu-wasm', () => {
    let wasm: Wasm;
    beforeAll(async () => {
      wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
      const blob = resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm');
      wasm.initSync({ module: readFileSync(blob) });
    });

    const withKeys = <T>(account: number, f: (k: InstanceType<Wasm['SpendKeys']>) => T): T => {
      const keys = new wasm.SpendKeys(SEED, account, true);
      try {
        return f(keys);
      } finally {
        keys.free();
      }
    };

    test('hot: the index 3 key of pocket 0 controls it, so the shield signs it', () => {
      const [index] = utxosByTIndex([utxo], pocketAddresses(0, undefined)).keys();
      expect(
        isP2pkhOf(
          utxo.script,
          withKeys(0, k => k.transparent_pubkey(index!)),
        ),
      ).toBe(true);
    });

    test('hot: pocket 1 can never sign it', () => {
      // an address outside the pocket falls back to index 0, whose key refuses it
      const [index] = utxosByTIndex([utxo], pocketAddresses(1, 12)).keys();
      for (const i of [index!, 3]) {
        expect(
          isP2pkhOf(
            utxo.script,
            withKeys(1, k => k.transparent_pubkey(i)),
          ),
        ).toBe(false);
      }
    });

    test('cold: the ufvk shows index 0 and shields legacy index 3 with its own key', () => {
      const ufvk = withKeys(0, k => k.ufvk());
      const cold = pocketTransparentIndices(undefined).map(i =>
        wasm.transparent_address_from_ufvk(ufvk, i),
      );
      expect(cold[0]).toBe(deriveZcashTransparentAddress(SEED, 0, 0, true));
      expect(cold[3]).toBe(legacy3);
      const index = tIndexOf(cold)(utxo);
      expect(index).toBe(3);
      expect(isP2pkhOf(utxo.script, wasm.transparent_pubkey_from_ufvk(ufvk, index))).toBe(true);
    });
  });
});

describe('receive hands out no new transparent index', () => {
  // vitest runs from apps/extension
  const src = (p: string) => readFileSync(resolve(process.cwd(), 'src', p), 'utf8');

  test('the legacy index key is only ever read', () => {
    const hook = src('hooks/use-transparent-addresses.ts');
    expect(hook).toMatch(
      /pocketTransparentIndices\(\s*\(await chrome\.storage\.local\.get\(indexKey\)\)/,
    );
    expect(hook).not.toMatch(/\[indexKey\]:/);
    expect(src('routes/popup/receive/receive-tab.tsx')).not.toMatch(/zcashTransparentIndex/);
  });
});
