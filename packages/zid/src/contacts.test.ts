import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  upsertContact,
  removeContact,
  establishContactSecret,
  getContactRootSecret,
} from './contacts';
import type { ContactCardKey } from './types';

// node test env has no localStorage; back it with a Map for each test.
const makeLocalStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
};

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const card = (suite = 'x25519-v1'): ContactCardKey => ({
  suite,
  publicKey: 'ab'.repeat(32),
});
// a derive-fn like the extension injects: valid for x25519-v1, fail-closed otherwise.
const makeDerive = (fill = 7) =>
  vi.fn((c: ContactCardKey): Uint8Array => {
    if (c.suite !== 'x25519-v1') {
      throw new Error(`unsupported contact suite: ${c.suite}`);
    }
    return new Uint8Array(32).fill(fill);
  });

describe('contact-card storage + establish-once-cache', () => {
  it('persists the contact card verbatim through storage', () => {
    upsertContact('p1', 'Alice', card());
    const raw = JSON.parse(localStorage.getItem('zid_contacts') ?? '[]');
    const rec = raw.find((c: { pubkey: string }) => c.pubkey === 'p1');
    expect(rec.card).toEqual({ suite: 'x25519-v1', publicKey: 'ab'.repeat(32) });
  });

  it('legacy contact (no card) yields null, never crashes, never derives', () => {
    upsertContact('p2', 'Bob'); // no card
    const derive = makeDerive();
    expect(establishContactSecret('p2', derive)).toBeNull();
    expect(derive).not.toHaveBeenCalled();
  });

  it('establishes once and caches (second call does not re-derive)', () => {
    upsertContact('p3', 'Carol', card());
    const derive = makeDerive(9);
    const s1 = establishContactSecret('p3', derive);
    const s2 = establishContactSecret('p3', derive);
    expect(s1).not.toBeNull();
    expect(s1!.length).toBe(32);
    expect(Array.from(s1!)).toEqual(Array.from(s2!));
    expect(derive).toHaveBeenCalledTimes(1); // "establish once"
    // returned bytes are a caller-owned copy — mutating them doesn't poison the cache
    s1!.fill(0);
    const s3 = getContactRootSecret('p3');
    expect(s3!.every(b => b === 9)).toBe(true);
  });

  it('unknown suite fails closed: derive throws, nothing is cached', () => {
    upsertContact('p4', 'Dave', card('xwing-v1'));
    const derive = makeDerive();
    expect(() => establishContactSecret('p4', derive)).toThrow(/unsupported contact suite/);
    expect(getContactRootSecret('p4')).toBeNull();
  });

  it('rotating the peer KA key invalidates the stale cached secret', () => {
    upsertContact('p5', 'Erin', card());
    const derive = makeDerive(1);
    establishContactSecret('p5', derive);
    expect(getContactRootSecret('p5')).not.toBeNull();
    // peer rotates their contact-card key
    upsertContact('p5', 'Erin', { suite: 'x25519-v1', publicKey: 'cd'.repeat(32) });
    expect(getContactRootSecret('p5')).toBeNull(); // stale secret dropped
  });

  it('getContactRootSecret is null before establish and removeContact wipes it', () => {
    upsertContact('p6', 'Frank', card());
    expect(getContactRootSecret('p6')).toBeNull();
    establishContactSecret('p6', makeDerive());
    expect(getContactRootSecret('p6')).not.toBeNull();
    removeContact('p6');
    expect(getContactRootSecret('p6')).toBeNull();
  });
});
