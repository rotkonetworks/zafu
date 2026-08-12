// Wire-contract tests for the host->joiner relay messages.
//
// The host ENCODES with sendSignPrefix/sendCommitments/sendShare; the joiner
// DECODES with the regexes inside subscribePeers. Those two live in the same
// file but nothing checked they agree, and the decoder is a regex over a
// colon-delimited string - the classic place for a field to go missing without
// anyone noticing.
//
// It matters more here than in most protocols because the relay is
// unauthenticated (see multisig-verifier.test.ts): a joiner acts on whatever
// parses. A message that fails to parse is silently IGNORED - no error, no
// callback - so a mis-encoded field does not surface as a failure, it surfaces
// as a signing session that hangs forever.
//
// These tests drive the real encoder into the real decoder over a fake
// transport, so the assertion is round-trip fidelity rather than either side's
// idea of the format.

import { describe, expect, it, vi } from 'vitest';
import {
  sendSignPrefix,
  sendCommitments,
  sendShare,
  subscribePeers,
  type RelaySession,
} from './relay-protocol';

const SIGHASH = 'ab'.repeat(32);
const ALPHA_0 = '11'.repeat(32);
const ALPHA_1 = '22'.repeat(32);
const PCZT = 'deadbeef'.repeat(4);
const RECIPIENT = 'u1qz8k4mre0000000000000000000000000000000000000';

/**
 * A relay that loops the host's sent bytes straight back into the joiner's
 * subscription, which is exactly the path a co-signer sees.
 */
function loopbackSession() {
  let handler: ((e: unknown) => void) | undefined;
  const sent: string[] = [];
  const session = {
    relay: {
      joinRoom: vi.fn((_room: string, _pid: Uint8Array, h: (e: unknown) => void) => {
        handler = h;
        return Promise.resolve();
      }),
      sendMessage: vi.fn((_room: string, _pid: Uint8Array, payload: Uint8Array) => {
        sent.push(new TextDecoder().decode(payload));
        handler?.({ type: 'message', message: { payload } });
        return Promise.resolve();
      }),
    },
    roomCode: 'ROOM',
    participantId: new Uint8Array(32),
    abort: new AbortController(),
  } as unknown as RelaySession;
  return { session, sent };
}

describe('SIGN: host encode -> joiner decode', () => {
  it('round-trips the sighash, every alpha, and the PCZT the joiner verifies against', async () => {
    const { session } = loopbackSession();
    const onSign = vi.fn();
    subscribePeers(session, 2, undefined, onSign);

    await sendSignPrefix(session, SIGHASH, [ALPHA_0, ALPHA_1], RECIPIENT, '600000', '10000', PCZT);

    expect(onSign).toHaveBeenCalledTimes(1);
    const [sighash, alphas, recipient, amountZat, feeZat, pcztHex] = onSign.mock.calls[0]!;
    expect(sighash).toBe(SIGHASH);
    // The alphas are comma-joined on the wire; a joiner signing with a truncated
    // or reordered list produces signatures that do not verify.
    expect(alphas).toEqual([ALPHA_0, ALPHA_1]);
    expect(recipient).toBe(RECIPIENT);
    expect(amountZat).toBe('600000');
    expect(feeZat).toBe('10000');
    expect(pcztHex).toBe(PCZT);
  });

  it('accepts a numeric amountZat, which the host type allows', async () => {
    const { session } = loopbackSession();
    const onSign = vi.fn();
    subscribePeers(session, 1, undefined, onSign);

    // sendSignPrefix takes `string | number`; the decoder only matches \d+.
    await sendSignPrefix(session, SIGHASH, [ALPHA_0], RECIPIENT, 600000, '10000', PCZT);

    expect(onSign).toHaveBeenCalledTimes(1);
    expect(onSign.mock.calls[0]![3]).toBe('600000');
  });

  it('parses a PCZT-less SIGN so it can be REPORTED rather than silently dropped', async () => {
    // Syntactically optional, semantically mandatory: every joiner refuses to
    // sign without the PCZT, but the message must still reach the joiner so it
    // can say so. Dropping it at the parser would be indistinguishable from a
    // dead relay.
    const { session } = loopbackSession();
    const onSign = vi.fn();
    subscribePeers(session, 1, undefined, onSign);

    await sendSignPrefix(session, SIGHASH, [ALPHA_0], RECIPIENT, '600000', '10000');

    expect(onSign).toHaveBeenCalledTimes(1);
    expect(onSign.mock.calls[0]![5]).toBeUndefined();
  });

  it('IGNORES a SIGN whose amount is not an integer - a silent hang, not an error', async () => {
    // Documents a sharp edge rather than asserting it is good: the decoder
    // requires \d+, so a decimal amount never reaches onSign. There is no error
    // path - the joiner simply waits forever. Worth pinning so a future change
    // to amount formatting fails a test instead of a signing session.
    const { session } = loopbackSession();
    const onSign = vi.fn();
    subscribePeers(session, 1, undefined, onSign);

    await sendSignPrefix(session, SIGHASH, [ALPHA_0], RECIPIENT, '0.006', '10000', PCZT);

    expect(onSign).not.toHaveBeenCalled();
  });

  it('IGNORES a SIGN whose recipient contains the delimiter', async () => {
    // The format is colon-delimited with no escaping. A unified address never
    // contains a colon, so this is not reachable today - but it is the reason
    // the recipient field must stay colon-free.
    const { session } = loopbackSession();
    const onSign = vi.fn();
    subscribePeers(session, 1, undefined, onSign);

    await sendSignPrefix(session, SIGHASH, [ALPHA_0], 'u1bad:addr', '600000', '10000', PCZT);

    expect(onSign).not.toHaveBeenCalled();
  });
});

describe('C: and S: bucketing', () => {
  it('buckets one commitment per action, in action order', async () => {
    const { session } = loopbackSession();
    const buckets = subscribePeers(session, 3);

    await sendCommitments(session, ['c0', 'c1', 'c2']);

    expect(buckets.peerCommits[0]).toEqual(['c0']);
    expect(buckets.peerCommits[1]).toEqual(['c1']);
    expect(buckets.peerCommits[2]).toEqual(['c2']);
  });

  it('does not overflow its buckets when a peer sends more commitments than actions', async () => {
    // The relay is unauthenticated, so "more parts than actions" is an input a
    // hostile room member can produce at will.
    const { session } = loopbackSession();
    const buckets = subscribePeers(session, 2);

    await sendCommitments(session, ['c0', 'c1', 'c2', 'c3']);

    expect(buckets.peerCommits).toHaveLength(2);
    expect(buckets.peerCommits[0]).toEqual(['c0']);
    expect(buckets.peerCommits[1]).toEqual(['c1']);
  });

  it('routes each share to ITS action index', async () => {
    const { session } = loopbackSession();
    const buckets = subscribePeers(session, 2);

    await sendShare(session, 1, 'share-for-action-1');
    await sendShare(session, 0, 'share-for-action-0');

    expect(buckets.peerShares[0]).toEqual(['share-for-action-0']);
    expect(buckets.peerShares[1]).toEqual(['share-for-action-1']);
  });

  it('drops a share aimed at an action index that does not exist', async () => {
    const { session } = loopbackSession();
    const buckets = subscribePeers(session, 2);

    await sendShare(session, 7, 'out-of-range');

    expect(buckets.peerShares[0]).toEqual([]);
    expect(buckets.peerShares[1]).toEqual([]);
  });
});
