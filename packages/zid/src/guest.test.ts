import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { XWING_SUITE, pqKeyAuthMessage } from '@zafu/pq';
import { createGuestIdentity } from './guest';
import { ZafuError } from './errors';
import {
  ContactRelay,
  PRESENCE_BLOB_BYTES,
  PRESENCE_PAD_TO,
  type PresenceEntry,
  type RelayTransport,
} from './contact-relay';
import { createPresenceService } from './presence-service';
import type { ZidIdentity } from './types';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** node has no localStorage; persist:'local' needs one to be exercised. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

/** the parity surface, with the optional members narrowed to present. */
function surface(id: ZidIdentity) {
  const { keys, sealFor, openSealed, contactCard, deriveRootSecret, establishSecret, discover } =
    id;
  if (
    !keys ||
    !sealFor ||
    !openSealed ||
    !contactCard ||
    !deriveRootSecret ||
    !establishSecret ||
    !discover
  ) {
    throw new Error('expected the ephemeral identity to expose the full parity surface');
  }
  return { keys, sealFor, openSealed, contactCard, deriveRootSecret, establishSecret, discover };
}

/** assert `p` was REFUSED with a typed ZafuError, and return it to inspect the code. */
async function refusal(p: Promise<unknown>): Promise<ZafuError> {
  const caught = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(ZafuError);
  return caught as ZafuError;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('guest identity - keys derived from one seed', () => {
  it('is stable across connects when the seed is persisted locally', () => {
    const a = createGuestIdentity({ origin: 'https://a.example', persist: 'local' });
    const b = createGuestIdentity({ origin: 'https://a.example', persist: 'local' });

    expect(b.pubkey).toBe(a.pubkey);
    expect(surface(b).keys().pq_pubkey).toBe(surface(a).keys().pq_pubkey);
    expect(surface(b).contactCard().publicKey).toBe(surface(a).contactCard().publicKey);
  });

  it('is deterministic for an injected seed', () => {
    const seed = new Uint8Array(32).fill(7);
    const a = createGuestIdentity({ origin: 'https://d.example', seed });
    const b = createGuestIdentity({ origin: 'https://d.example', seed });

    expect(b.pubkey).toBe(a.pubkey);
    expect(surface(b).keys().pq_pubkey).toBe(surface(a).keys().pq_pubkey);
  });

  it('derives distinct keys per origin - a guest is not linkable across sites', () => {
    const seed = new Uint8Array(32).fill(9);
    const a = createGuestIdentity({ origin: 'https://a.example', seed });
    const b = createGuestIdentity({ origin: 'https://b.example', seed });

    expect(a.pubkey).not.toBe(b.pubkey);
    expect(surface(a).keys().pq_pubkey).not.toBe(surface(b).keys().pq_pubkey);
  });

  it('advertises an X-Wing key authenticated by its own ed25519 identity', () => {
    const k = surface(createGuestIdentity({ origin: 'https://a.example' })).keys();

    expect(k.pq_suite).toBe(XWING_SUITE);
    expect(k.pq_pubkey).toHaveLength(1216 * 2);
    expect(k.pq_epoch).toBe(0);
    expect(
      ed25519.verify(
        hexToBytes(k.pq_sig ?? ''),
        pqKeyAuthMessage(
          k.pq_suite ?? '',
          k.origin ?? '',
          k.pq_epoch ?? 0,
          hexToBytes(k.pq_pubkey ?? ''),
        ),
        hexToBytes(k.pubkey),
      ),
    ).toBe(true);
  });
});

describe('guest identity - sealed boxes', () => {
  it('round-trips the post-quantum path between two guests', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    const bob = surface(createGuestIdentity({ origin: 'https://b.example' }));

    const sealed = await alice.sealFor(bob.keys(), utf8('gm'));

    expect(sealed.postQuantum).toBe(true);
    expect(sealed.ephemeral_pubkey).toHaveLength(0); // the ephemeral rides inside the wire
    expect(decode(await bob.openSealed(sealed))).toBe('gm');
  });

  it('falls back to the classical box when the peer advertises no PQ key', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    const bob = surface(createGuestIdentity({ origin: 'https://b.example' }));

    const sealed = await alice.sealFor({ pubkey: bob.keys().pubkey }, utf8('hi'));

    expect(sealed.postQuantum).toBe(false);
    expect(sealed.ephemeral_pubkey).toHaveLength(32);
    expect(decode(await bob.openSealed(sealed))).toBe('hi');
  });

  it('treats a bare pubkey string as a classical recipient', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    const bob = surface(createGuestIdentity({ origin: 'https://b.example' }));

    const sealed = await alice.sealFor(bob.keys().pubkey, utf8('yo'));

    expect(sealed.postQuantum).toBe(false);
    expect(decode(await bob.openSealed(sealed))).toBe('yo');
  });

  it('refuses an unauthenticated post-quantum prekey instead of downgrading', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    const stranger = surface(createGuestIdentity({ origin: 'https://s.example' })).keys();

    await expect(
      alice.sealFor({ pubkey: stranger.pubkey, pq_pubkey: stranger.pq_pubkey }, utf8('x')),
    ).rejects.toBeInstanceOf(ZafuError);
  });

  it('refuses to seal to the ed25519 identity point (degenerate DH)', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    const identityPoint = '01' + '00'.repeat(31); // (0,1): a valid encoding, a useless key

    expect((await refusal(alice.sealFor({ pubkey: identityPoint }, utf8('x')))).code).toBe(
      'invalid_request',
    );
  });

  it('refuses to seal to an off-curve encoding', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));

    expect((await refusal(alice.sealFor({ pubkey: 'ff'.repeat(32) }, utf8('x')))).code).toBe(
      'invalid_request',
    );
  });

  it('refuses to open a box whose ephemeral key is degenerate', async () => {
    const bob = surface(createGuestIdentity({ origin: 'https://b.example' }));
    const ciphertext = new Uint8Array(64); // long enough to reach the DH, not the length guard

    const allZero = await refusal(
      bob.openSealed({ ciphertext, ephemeral_pubkey: new Uint8Array(32) }),
    );
    expect(allZero.code).toBe('invalid_request');

    const u1 = new Uint8Array(32);
    u1[0] = 1;
    expect((await refusal(bob.openSealed({ ciphertext, ephemeral_pubkey: u1 }))).code).toBe(
      'invalid_request',
    );
  });
});

describe('guest identity - contact discovery', () => {
  it('derives the same pairwise root secret from either side', () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    const bob = surface(createGuestIdentity({ origin: 'https://b.example' }));

    expect(bytesToHex(alice.deriveRootSecret(bob.contactCard()))).toBe(
      bytesToHex(bob.deriveRootSecret(alice.contactCard())),
    );
  });

  it('fails closed on an unsupported contact suite', () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    expect(() => alice.deriveRootSecret({ suite: 'xwing-v1', publicKey: 'ab'.repeat(32) })).toThrow(
      ZafuError,
    );
  });

  it('establishSecret returns null for a contact that was never stored', () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    expect(alice.establishSecret('deadbeef')).toBeNull();
  });

  it('needs a relay transport to discover', async () => {
    const alice = surface(createGuestIdentity({ origin: 'https://a.example' }));
    await expect(alice.discover([])).rejects.toBeInstanceOf(ZafuError);
  });

  it('finds a peer that published presence under the shared rendezvous tag', async () => {
    const APP = 'poker.zk.bot';
    const EPOCH = 4242;
    const store = new Map<string, PresenceEntry[]>();
    const transport: RelayTransport = {
      async putBucket(req) {
        store.set(`${req.appScope}|${req.epoch}|${req.shard}`, req.entries);
      },
      async getBucket(req) {
        return store.get(`${req.appScope}|${req.epoch}|${req.shard}`) ?? [];
      },
    };

    const alice = surface(createGuestIdentity({ origin: APP, relayTransport: transport }));
    const bob = surface(createGuestIdentity({ origin: APP }));
    const rootSecret = bob.deriveRootSecret(alice.contactCard());

    // bob announces himself to alice (under bob's own card pubkey, in the a2b/b2a
    // direction fixed by pubkey order).
    const bobRelay = new ContactRelay(transport, {
      appOrigin: APP,
      padTo: PRESENCE_PAD_TO,
      blobBytes: PRESENCE_BLOB_BYTES,
    });
    const bobService = createPresenceService(bobRelay, APP, bob.contactCard().publicKey);
    await bobService.publishSelf(
      { sessionPub: new Uint8Array(32).fill(3), caps: 0b101 },
      [{ id: 'alice', friendPubHex: alice.contactCard().publicKey, rootSecret }],
      EPOCH,
    );

    const found = await alice.discover(
      [{ id: 'bob', friendPubHex: bob.contactCard().publicKey, rootSecret }],
      { epoch: EPOCH },
    );

    expect(found).toEqual([
      { id: 'bob', sessionPubHex: bytesToHex(new Uint8Array(32).fill(3)), caps: 0b101 },
    ]);
  });
});
