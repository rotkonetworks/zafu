/**
 * Cross-stack contract test: the REAL rendezvous-client against a REAL
 * zidecar rendezvous. The unit tests prove each side alone; this proves the
 * wire contract (paths, snake_case field names, status codes) between them.
 *
 *   RENDEZVOUS_URL=http://127.0.0.1:2799 pnpm vitest run src/state/keyring/rendezvous-client.live.test.ts
 *
 * Skipped when RENDEZVOUS_URL is unset, so CI without a server stays green.
 */

import { describe, expect, it } from 'vitest';
import {
  announceSession,
  generateRoomCode,
  hasRendezvous,
  offerRoomCode,
  pollRoom,
  publishKey,
  resolveRoomCode,
  roomIdFromCode,
} from './rendezvous-client';

const url = process.env['RENDEZVOUS_URL'];

describe.skipIf(!url)('rendezvous against a live zidecar', () => {
  const relay = url!;
  const pubkey = (b: number) => b.toString(16).padStart(2, '0').repeat(32);

  it('is detected by the probe', async () => {
    expect(await hasRendezvous(relay)).toBe(true);
  });

  it('walks the DKG discovery round-trip', async () => {
    const code = generateRoomCode();
    const roomId = await roomIdFromCode(code);

    // coordinator creates the room
    const token = await publishKey(relay, roomId, pubkey(0xa1), 'coordinator');
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // a joiner publishes; no token for them
    expect(await publishKey(relay, roomId, pubkey(0xb2), 'joiner')).toBeNull();

    // both keys visible, no session yet
    const view = await pollRoom(relay, roomId);
    expect(view.entries.map(e => e.pubkey).sort()).toEqual([pubkey(0xa1), pubkey(0xb2)].sort());
    expect(view.sessionId).toBeNull();

    // coordinator announces; the joiner resolves the session out
    const sessionId = crypto.randomUUID();
    await announceSession(relay, roomId, token!, sessionId);
    expect(await resolveRoomCode(relay, code, 5_000)).toBe(sessionId);
  });

  it('walks the signing offer/resolve pair', async () => {
    const sessionId = crypto.randomUUID();
    const code = await offerRoomCode(relay, pubkey(0xc3), sessionId);
    expect(code).not.toBeNull();
    expect(await resolveRoomCode(relay, code!, 5_000)).toBe(sessionId);
  });

  it('refuses an announce without the creator token', async () => {
    const roomId = await roomIdFromCode(generateRoomCode());
    await publishKey(relay, roomId, pubkey(0xd4));
    await expect(
      announceSession(relay, roomId, '0'.repeat(32), crypto.randomUUID()),
    ).rejects.toThrow(/403/);
  });
});
