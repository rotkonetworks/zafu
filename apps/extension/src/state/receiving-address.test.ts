import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  encodeOrchardUnifiedAddress,
  fixOrchardAddress,
  orchardReceiverOf,
} from '@repo/wallet/networks/zcash/unified-address';
import type { Contact } from './contacts';
import { matchReceiver, receivingAddress } from './receiving-address';

// The real wasm derives the addresses (in its `u1orchard:<hex>` form, the raw
// receiver a scanned note stores); the TS side encodes and decodes them.
interface Wasm {
  initSync(o: { module: Uint8Array }): void;
  SpendKeys: new (seed: string, account: number, mainnet: boolean) => { ufvk(): string };
  address_from_ufvk(ufvk: string, index: number): string;
}
let wasm: Wasm;
let alice: string;
let other: string;

beforeAll(async () => {
  wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
  wasm.initSync({
    module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
  });
  alice = new wasm.SpendKeys(Array(23).fill('abandon').concat('art').join(' '), 0, true).ufvk();
  other = new wasm.SpendKeys(Array(11).fill('abandon').concat('about').join(' '), 0, true).ufvk();
});

/** the raw receiver a scanned note paid at `index` stores (hex) */
const rawAt = (ufvk: string, index: number) =>
  wasm.address_from_ufvk(ufvk, index).replace(/^u1orchard:/, '');
/** the unified address zafu shows for that index */
const uaAt = (ufvk: string, index: number) =>
  fixOrchardAddress(wasm.address_from_ufvk(ufvk, index), true);

const contact = (id: string, name: string, address: string): Contact => ({
  id,
  name,
  createdAt: 0,
  addresses: [{ id: `${id}-a`, network: 'zcash', address }],
});

describe('orchardReceiverOf', () => {
  it('reads the receiver out of a real mainnet address with more than one receiver', () => {
    // packages/wallet/src/license.ts: made by another wallet, orchard + transparent
    const ua =
      'u1c6wkke2ytaysykam55gratnrne62yx0rvup45qrcyrt5j2wy0g3qvp4y3z97rsq5madg82sntg0gpkadfccelyd7jh0mks65rc9z9wss';
    expect(orchardReceiverOf(ua)?.length).toBe(43);
  });

  it('turns every address zafu shows back into the receiver the wasm derived', () => {
    for (const i of [0, 1, 1005, 4_000_000_000]) {
      const raw = orchardReceiverOf(uaAt(alice, i))!;
      expect(Array.from(raw, b => b.toString(16).padStart(2, '0')).join('')).toBe(rawAt(alice, i));
      expect(encodeOrchardUnifiedAddress(raw, true)).toBe(uaAt(alice, i));
    }
  });

  it('refuses a changed character and things that are not unified addresses', () => {
    const ua = uaAt(alice, 7);
    const flipped = ua.slice(0, 20) + (ua[20] === 'q' ? 'p' : 'q') + ua.slice(21);
    expect(orchardReceiverOf(flipped)).toBeUndefined();
    expect(orchardReceiverOf('t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU')).toBeUndefined();
    expect(orchardReceiverOf('')).toBeUndefined();
  });
});

describe('matchReceiver: who a payment came from, by the address it was paid to', () => {
  const BOB_OWN = 'u1bobsownaddressforpayingbob';

  it('finds the person you gave that address to, and their own address to answer', () => {
    const records = [
      { diversifierIndex: 1005, sharedWith: 'bob-id', address: uaAt(alice, 1005), sharedAt: 1 },
    ];
    const bob = contact('bob-id', 'bob', BOB_OWN);
    expect(matchReceiver(rawAt(alice, 1005), records, [bob])).toEqual({
      diversifierIndex: 1005,
      contact: bob,
      personAddress: BOB_OWN,
    });
    expect(receivingAddress(rawAt(alice, 1005))).toBe(uaAt(alice, 1005));
  });

  it('reads older records: keyed by name, holding the wasm debug form', () => {
    const records = [
      {
        diversifierIndex: 1006,
        sharedWith: 'bob',
        address: wasm.address_from_ufvk(alice, 1006),
        sharedAt: 1,
      },
    ];
    expect(
      matchReceiver(rawAt(alice, 1006), records, [contact('x', 'bob', BOB_OWN)])?.personAddress,
    ).toBe(BOB_OWN);
  });

  it('knows the index of a card you showed, though no one is saved for it', () => {
    const records = [
      {
        diversifierIndex: 1234,
        sharedWith: 'a card you showed',
        address: uaAt(alice, 1234),
        sharedAt: 1,
      },
    ];
    expect(matchReceiver(rawAt(alice, 1234), records, [])).toEqual({
      diversifierIndex: 1234,
      contact: undefined,
      personAddress: undefined,
    });
  });

  it('matches nobody for an address never handed out, or another wallet at the same index', () => {
    const records = [
      { diversifierIndex: 1005, sharedWith: 'bob-id', address: uaAt(alice, 1005), sharedAt: 1 },
    ];
    const bob = contact('bob-id', 'bob', BOB_OWN);
    expect(matchReceiver(rawAt(alice, 0), records, [bob])).toBeUndefined();
    expect(matchReceiver(rawAt(other, 1005), records, [bob])).toBeUndefined();
    expect(matchReceiver(undefined, records, [bob])).toBeUndefined();
    expect(matchReceiver('zz', records, [bob])).toBeUndefined();
  });
});
