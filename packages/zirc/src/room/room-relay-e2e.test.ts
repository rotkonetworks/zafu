/**
 * End-to-end check against a REAL relay (`apps/minirelay`, Rust+SQLite), the
 * zirc-level counterpart to `@zafu/zid`'s `relay-e2e.test.ts`.
 *
 * Opt-in, same convention as the zid suite:
 *
 *   cd apps/minirelay && cargo run --release &
 *   MINIRELAY_URL=http://127.0.0.1:8080 pnpm --filter @zafu/zirc test
 *
 * With `MINIRELAY_URL` unset everything here is skipped, so the package's own
 * suite stays hermetic. What this proves that the in-memory fake relay in
 * `room.test.ts` cannot: a 1053-byte sealed room record (1404 base64 chars) -
 * the exact shape blocker 1 made unreadable - round-trips through the real
 * wire contract once `relayLimitsFor` sizes the transport correctly, and a
 * member who joins later catches up with `Room.syncSince`.
 */
import { describe, expect, it } from 'vitest';
import { createGuestIdentity, createHttpRelayTransport, ZidIdentity } from '@zafu/zid';
import { GROUP_ROOM_PLAINTEXT_BYTES, Room, relayLimitsFor, type RoomIdentity } from './room';

const url = process.env['MINIRELAY_URL'];
const when = url === undefined || url === '' ? describe.skip : describe;

const asIdentity = (id: ZidIdentity, name: string): RoomIdentity => ({
  pubkey: id.pubkey,
  name,
  sign: id.sign,
  verify: id.verify,
});

const member = (seed: number, name: string) =>
  asIdentity(
    createGuestIdentity({ origin: 'zirc-e2e', seed: new Uint8Array(32).fill(seed) }),
    name,
  );

when('minirelay + a real zirc room (real server, opt-in)', () => {
  it('two members exchange a group-sized (1.4 KB) sealed record through a real relay', async () => {
    const appScope = `zirc-e2e-group-${Date.now()}`;
    const relay = createHttpRelayTransport({
      endpoint: url ?? '',
      ...relayLimitsFor(GROUP_ROOM_PLAINTEXT_BYTES),
    });
    const secret = crypto.getRandomValues(new Uint8Array(32));

    const alice = new Room(member(1, 'alice'), {
      appScope,
      roomSecret: secret,
      relay,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const bob = new Room(member(2, 'bob'), {
      appScope,
      roomSecret: secret,
      relay,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });

    const body = 'a sealed group record riding the real minirelay wire contract';
    await alice.send(body);

    const synced = await bob.sync(1);
    expect(synced.messages.map(m => m.body)).toEqual([body]);
    expect(synced.dropped).toHaveLength(0);
  }, 20_000);

  it('a third member who joins later catches up on every retained window via syncSince, not just sync(historyWindows)', async () => {
    const appScope = `zirc-e2e-syncsince-${Date.now()}`;
    const relay = createHttpRelayTransport({
      endpoint: url ?? '',
      ...relayLimitsFor(GROUP_ROOM_PLAINTEXT_BYTES),
    });
    const secret = crypto.getRandomValues(new Uint8Array(32));

    const alice = new Room(member(3, 'alice'), {
      appScope,
      roomSecret: secret,
      relay,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const sinceEpoch = alice.currentEpoch();
    await alice.send('first message, before the newcomer arrives');

    // a member built AFTER the fact, as if it had just opened this room for
    // the first time - historyWindows (12 = 1h) would already cover this in a
    // live run since the test is fast, so what this exercises is the shape of
    // the call a returning member makes, not the retention window itself
    // (minirelay's own retention is covered by the Rust store tests).
    const carol = new Room(member(4, 'carol'), {
      appScope,
      roomSecret: secret,
      relay,
      plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES,
    });
    const caughtUp = await carol.syncSince(sinceEpoch, 288);
    expect(caughtUp.messages.map(m => m.body)).toEqual([
      'first message, before the newcomer arrives',
    ]);
  }, 20_000);
});
