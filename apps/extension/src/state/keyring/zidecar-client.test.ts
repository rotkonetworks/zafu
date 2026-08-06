import { describe, expect, it } from 'vitest';
import { ZidecarClient } from './zidecar-client';

/**
 * Field-number regression tests for the hand-rolled protobuf decoding in
 * `zidecar-client.ts`.
 *
 * This file exists because the same class of bug has now shipped twice: a
 * field number in the decoder drifting from `proto/zidecar.proto`. Neither was
 * caught by types, by the build, or by any other test, because a protobuf
 * decoder that reads the wrong field number is still perfectly valid code —
 * it just returns a plausible-looking number that means something else.
 *
 *   1. `ironwood_tree` was read from field 7 when the proto says 6, so every
 *      ironwood send failed against a healthy server.
 *   2. `blocks_until_ready` (6) and `last_epoch_proof_height` (7) were swapped
 *      in `parseSyncStatus`, so the wallet read "proof ready, last proof at
 *      height 3,437,567" as "no proof yet, 3,437,567 blocks to go" and pinned
 *      the ligerito stage at 0% forever, displaying "server catching up" on a
 *      server that was fully caught up.
 *
 * The fixture below is a REAL `GetSyncStatus` response captured from
 * https://zcash.rotko.net, not a hand-built message — so it pins the decoder
 * against what a production server actually emits, including the fact that a
 * zero-valued field (`blocks_until_ready`) is OMITTED from the wire entirely.
 * That omission is what made the swap invisible: the absent field defaulted to
 * 0 and the wrong field supplied a large, believable number.
 */

/** Real `GetSyncStatus` response body from zcash.rotko.net (gRPC-web frame stripped). */
const REAL_SYNC_STATUS = new Uint8Array([
  0x08, 0xbc, 0xee, 0xd1, 0x01, // 1: current_height       = 3_438_396
  0x10, 0x9d, 0x1a, //             2: current_epoch        = 3_357
  0x18, 0xbc, 0x06, //             3: blocks_in_epoch      = 828
  0x20, 0x9c, 0x1a, //             4: complete_epochs      = 3_356
  0x28, 0x02, //                   5: epoch_proof_status   = 2 (READY)
  //                               6: blocks_until_ready   = OMITTED (zero)
  0x38, 0xff, 0xe7, 0xd1, 0x01, // 7: last_epoch_proof_height = 3_437_567
]);

/** `parseSyncStatus` is private; these tests pin wire behaviour, not internals. */
const parse = (buf: Uint8Array) =>
  (
    ZidecarClient.prototype as unknown as {
      parseSyncStatus(b: Uint8Array): Record<string, number>;
    }
  ).parseSyncStatus(buf);

describe('parseSyncStatus field numbers', () => {
  it('decodes a real server response to the proto field semantics', () => {
    const s = parse(REAL_SYNC_STATUS);

    expect(s.currentHeight).toBe(3_438_396);
    expect(s.currentEpoch).toBe(3_357);
    expect(s.blocksInEpoch).toBe(828);
    expect(s.completeEpochs).toBe(3_356);
    expect(s.gigaproofStatus).toBe(2); // READY

    // The two that were swapped. proto/zidecar.proto:
    //   uint32 blocks_until_ready      = 6;  // 0 if ready
    //   uint32 last_epoch_proof_height = 7;
    expect(s.blocksUntilReady).toBe(0);
    expect(s.lastGigaproofHeight).toBe(3_437_567);
  });

  it('reports the ligerito proof as READY for this response', () => {
    const s = parse(REAL_SYNC_STATUS);

    // This is the user-visible consequence and the reason the bug mattered:
    // with the fields swapped, blocksUntilReady was 3,437,567, the stage
    // computed 0% forever and rendered "server catching up" against a server
    // that had a proof at height 3,437,567 — 829 blocks off a 3,438,396 tip.
    expect(s.gigaproofStatus).toBeGreaterThanOrEqual(2);
    expect(s.blocksUntilReady).toBeLessThanOrEqual(0);
  });

  it('keeps the two fields distinguishable by magnitude', () => {
    const s = parse(REAL_SYNC_STATUS);

    // A swap is caught by shape alone, without knowing the exact values: a
    // proof height sits near the chain tip, while a countdown to readiness is
    // small. If these two ever trade places again, this fails.
    expect(s.lastGigaproofHeight).toBeGreaterThan(s.currentHeight - 100_000);
    expect(s.lastGigaproofHeight).toBeLessThanOrEqual(s.currentHeight);
    expect(s.blocksUntilReady).toBeLessThan(100_000);
  });

  it('treats an omitted zero field as zero rather than inheriting a neighbour', () => {
    // blocks_until_ready is absent from the wire above. Protobuf omits zero
    // values, so a decoder that mis-numbers fields silently sources the value
    // from whichever field it landed on instead. Pin the default explicitly.
    const withoutProofHeight = REAL_SYNC_STATUS.slice(0, 16); // drop field 7
    const s = parse(withoutProofHeight);

    expect(s.blocksUntilReady).toBe(0);
    expect(s.lastGigaproofHeight).toBe(0);
    expect(s.currentHeight).toBe(3_438_396); // earlier fields still decode
  });
});
