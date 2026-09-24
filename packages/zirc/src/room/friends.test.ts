import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contactCount } from '@zafu/zid';
import { addFriend, forgetFriend, listFriends } from './friends';
import { shortId } from './commands';

const ORIGIN = 'http://localhost:3100';
const alice = { pubkey: 'a1'.repeat(32), name: 'alice' };
const bob = { pubkey: 'b2'.repeat(32), name: 'bob' };

/**
 * zid keeps contacts in localStorage, so the suite brings its own. That is also
 * the honest way to test this: a friend is a *stored* thing, and the assertions
 * below are about what survives a reload - which is the whole point of `/add`.
 */
const memory = new Map<string, string>();
const stubStorage = () => {
  memory.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
      key: (index: number) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
};

describe('friends', () => {
  beforeEach(stubStorage);
  afterEach(() => {
    memory.clear();
  });

  it('keeps a friend across a reload, and hands back the same key', async () => {
    addFriend(alice);
    expect(contactCount()).toBe(1);

    // a reload is a new read of the same store
    const friends = await listFriends(ORIGIN);
    expect(friends.map(f => [f.label, f.pubkey])).toEqual([['alice', alice.pubkey]]);
    expect(friends[0]!.handle).toMatch(/^[0-9a-f]+$/);
  });

  it('keeps the app-scoped handle stable, and unlinkable to the name', async () => {
    addFriend(alice);
    const first = (await listFriends(ORIGIN))[0]!.handle;
    const again = (await listFriends(ORIGIN))[0]!.handle;
    expect(again).toBe(first);
    expect(first).not.toContain('alice');
    // the same contact under another app is a different handle
    const elsewhere = await listFriends('https://other.example');
    expect(elsewhere[0]!.handle).not.toBe(first);
  });

  it('re-adds as a rename rather than a duplicate', async () => {
    addFriend(alice);
    addFriend({ ...alice, name: 'alice (sold me a bad LP)' });
    expect(contactCount()).toBe(1);
    expect((await listFriends(ORIGIN))[0]!.label).toBe('alice (sold me a bad LP)');
  });

  it('falls back to the id when a member has no name to keep', async () => {
    addFriend({ pubkey: bob.pubkey, name: '   ' });
    expect((await listFriends(ORIGIN))[0]!.label).toBe(shortId(bob.pubkey));
  });

  it('forgets one without touching the rest', async () => {
    addFriend(alice);
    addFriend(bob);
    forgetFriend(alice.pubkey);
    const friends = await listFriends(ORIGIN);
    expect(friends.map(f => f.pubkey)).toEqual([bob.pubkey]);
  });
});
