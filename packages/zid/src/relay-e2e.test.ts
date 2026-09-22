/**
 * End-to-end contract test against a REAL relay (`apps/minirelay`, Rust+SQLite).
 *
 * Opt-in, because it needs a server and the unit suite must stay hermetic:
 *
 *   cd apps/minirelay && cargo run --release &
 *   MINIRELAY_URL=http://127.0.0.1:8080 pnpm --filter @zafu/zid test
 *
 * With `MINIRELAY_URL` unset everything here is skipped. When it runs it is the
 * only test that exercises the wire contract against a second implementation
 * instead of a TypeScript double - which is exactly where a doc/implementation
 * mismatch (merge vs replace) hides.
 */
import { describe, expect, it } from 'vitest';

import {
  ContactRelay,
  PRESENCE_BLOB_BYTES,
  PRESENCE_PAD_TO,
  createGuestIdentity,
  createPresenceService,
  presenceEpoch,
} from './index';
import { rendezvousTag } from './contact-discovery';
import { createHttpRelayTransport } from './relay-http';

const url = process.env['MINIRELAY_URL'];
const token = process.env['MINIRELAY_TOKEN'];
const when = url === undefined || url === '' ? describe.skip : describe;

/**
 * A reachable relay, configured the way a wallet or guest would configure it.
 *
 * `MINIRELAY_TOKEN` exercises operator policy: a relay may require a bearer token
 * (who may use it), restrict which app scopes it serves, and cap request rates -
 * all server-side, none of it touching this client beyond a header.
 */
const relayFor = (appOrigin: string) =>
  new ContactRelay(
    createHttpRelayTransport({
      endpoint: url ?? '',
      ...(token === undefined || token === ''
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
    }),
    {
      appOrigin,
      padTo: PRESENCE_PAD_TO,
      blobBytes: PRESENCE_BLOB_BYTES,
    },
  );

const secret = (n: number) => new Uint8Array(32).fill(n);
const blob = (n: number) => new Uint8Array(PRESENCE_BLOB_BYTES).fill(n);

when('minirelay (real server, opt-in)', () => {
  it('round-trips a padded publish and finds both publishers of one coordinate', async () => {
    const app = `zid-e2e-${Date.now()}`;
    const epoch = presenceEpoch();

    // Two friends, each with the pairwise secret they share with the other.
    const shared = secret(9);
    const alicePub = 'a1'.repeat(32);
    const bobPub = 'b1'.repeat(32);

    // Alice announces under the tag Bob will look for, and vice versa.
    const alice = relayFor(app);
    const bob = relayFor(app);
    const aliceOut = await alice.publishPresence(
      [{ tag: rendezvousTag(shared, app, epoch, alicePub), blob: blob(1) }],
      epoch,
    );
    const bobOut = await bob.publishPresence(
      [{ tag: rendezvousTag(shared, app, epoch, bobPub), blob: blob(2) }],
      epoch,
    );

    // Each write is one whole padded batch: the relay must have MERGED them, not
    // kept the last.
    expect(aliceOut.perShard).toBe(PRESENCE_PAD_TO);
    expect(bobOut.perShard).toBe(PRESENCE_PAD_TO);

    const seenByAlice = await alice.discover(
      [{ id: 'bob', friendPubHex: bobPub, rootSecret: shared }],
      epoch,
    );
    const seenByBob = await bob.discover(
      [{ id: 'alice', friendPubHex: alicePub, rootSecret: shared }],
      epoch,
    );

    expect(seenByAlice.map(p => p.id)).toEqual(['bob']);
    expect(seenByBob.map(p => p.id)).toEqual(['alice']);
    expect(seenByBob[0]!.blob).toEqual(blob(1));
    expect(seenByAlice[0]!.blob).toEqual(blob(2));
  });

  it('does not match a stranger, and returns an empty bucket for an unused scope', async () => {
    const app = `zid-e2e-stranger-${Date.now()}`;
    const epoch = presenceEpoch();
    const shared = secret(4);

    await relayFor(app).publishPresence(
      [{ tag: rendezvousTag(shared, app, epoch, 'c1'.repeat(32)), blob: blob(3) }],
      epoch,
    );

    const present = await relayFor(app).discover(
      [{ id: 'stranger', friendPubHex: 'c1'.repeat(32), rootSecret: secret(5) }],
      epoch,
    );
    expect(present).toEqual([]);

    const unused = await relayFor(`${app}-unused`).discover(
      [{ id: 'nobody', friendPubHex: 'c1'.repeat(32), rootSecret: shared }],
      epoch,
    );
    expect(unused).toEqual([]);
  });

  it('is refused when the relay requires a token and none is sent', async () => {
    if (token === undefined || token === '') {
      return; // only meaningful against a token-gated relay
    }
    const app = `zid-e2e-notoken-${Date.now()}`;
    const epoch = presenceEpoch();
    const bare = new ContactRelay(createHttpRelayTransport({ endpoint: url ?? '' }), {
      appOrigin: app,
      padTo: PRESENCE_PAD_TO,
      blobBytes: PRESENCE_BLOB_BYTES,
    });

    await expect(
      bare.publishPresence(
        [{ tag: rendezvousTag(secret(3), app, epoch, 'e1'.repeat(32)), blob: blob(4) }],
        epoch,
      ),
    ).rejects.toThrow(/401/);
  });

  it('a friend reaches a gated relay with just the endpoint and token they were handed', async () => {
    if (token === undefined || token === '') {
      return; // only meaningful against a token-gated relay (or a friend's bouncer)
    }
    const app = `zid-e2e-handed-${Date.now()}`;
    const epoch = presenceEpoch();
    const shared = secret(11);
    const farPub = 'f1'.repeat(32);

    // the friend configures NOTHING but the two values from the invite: no
    // transport object, no headers, no fetch mock - the identity builds it, token
    // and all.
    const friend = createGuestIdentity({
      origin: app,
      appName: 'e2e',
      relayEndpoint: url ?? '',
      relayToken: token,
    });
    const card = friend.contactCard?.();
    const discover = friend.discover;
    if (!card || !discover) {
      throw new Error('a guest identity exposes a contact card and discovery');
    }

    // the far side announces the way a peer really does: under its own key,
    // sealed to the friend's contact card - so what the friend finds is a record
    // it can actually open, not filler bytes.
    await createPresenceService(relayFor(app), app, farPub).publishSelf(
      { sessionPub: new Uint8Array(32).fill(0x2a), caps: 7 },
      [{ id: 'friend', friendPubHex: card.publicKey, rootSecret: shared }],
      epoch,
    );

    const found = await discover([{ id: 'far', friendPubHex: farPub, rootSecret: shared }], {
      epoch,
    });
    expect(found.map((c: { id: string }) => c.id)).toEqual(['far']);
    expect(found[0]?.sessionPubHex).toBe('2a'.repeat(32));
  });

  it('the same endpoint without the token is refused', async () => {
    if (token === undefined || token === '') {
      return;
    }
    const app = `zid-e2e-nogrant-${Date.now()}`;
    const stranger = createGuestIdentity({
      origin: app,
      appName: 'e2e',
      relayEndpoint: url ?? '',
    });
    const discover = stranger.discover;
    if (!discover) {
      throw new Error('a guest identity exposes discovery');
    }
    await expect(
      discover([{ id: 'peer', friendPubHex: 'f1'.repeat(32), rootSecret: secret(11) }], {
        epoch: presenceEpoch(),
      }),
    ).rejects.toThrow(/401/);
  });

  it('re-publishing an epoch does not duplicate the friend', async () => {
    const app = `zid-e2e-republish-${Date.now()}`;
    const epoch = presenceEpoch();
    const shared = secret(7);
    const peer = 'd1'.repeat(32);
    const entry = { tag: rendezvousTag(shared, app, epoch, peer), blob: blob(6) };

    const relay = relayFor(app);
    await relay.publishPresence([entry], epoch);
    await relay.publishPresence([entry], epoch);

    const present = await relay.discover(
      [{ id: 'peer', friendPubHex: peer, rootSecret: shared }],
      epoch,
    );
    expect(present).toHaveLength(1);
  });
});
