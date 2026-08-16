// wire-tags used by both self-custody and airgap multisig signers on the relay:
//   SIGN:<sighash>:<alphas>:<recipient>:<amountZat>:<feeZat>[:<pcztHex>]
//                                                            — joiner display payload + verifier bytes
//   C:<commit_a0>|<commit_a1>|...                            — round-1 commitments per action
//   S:<actionIdx>:<share>                                    — round-2 share per action
//
// `pcztHex` is the standard pczt::Pczt the host built (gh #17 migration). Each
// joiner parses it via `frostInspectPcztOutputsInWorker`, recomputes the
// canonical sighash + OVK-decrypts outputs, and refuses to sign if they diverge
// from the host's claimed (recipient, amount) or sighash.
//
// It is syntactically optional and semantically MANDATORY. The regex still
// accepts a SIGN: without it so that such a message parses and can be reported,
// but every joiner refuses to sign one: without the PCZT the displayed
// recipient/amount are host-authored text bound to nothing, and "old host"
// is indistinguishable from "attacker who truncated the payload" on an
// unauthenticated relay. There is no host-claim-only fallback.
//
// NOT covered by any of this: `feeZat`. See assessClaimedFee() in
// multisig-verifier.ts — the fee cannot be checked without the bundle's
// value_balance, which the wasm parser does not return.

import { FrostdRelayClient } from '../../../../state/keyring/frostd-relay-client';
import {
  buildRelayIdentity,
  getOrCreateRelayIdentity,
} from '../../../../state/keyring/relay-identity';

export interface RelaySession {
  relay: FrostdRelayClient;
  roomCode: string;
  participantId: Uint8Array;
  abort: AbortController;
}

/**
 * Build a relay client for `ceremonyId`, sealed to `peerKeys`.
 *
 * A ceremony id rather than a device id: the relay identity is per-ceremony
 * so a relay operator cannot link a user's sessions to one another.
 */
async function clientFor(
  relayUrl: string,
  ceremonyId: string,
  peerKeys: string[],
): Promise<FrostdRelayClient> {
  if (peerKeys.length === 0) {
    throw new Error(
      'no peer relay keys: frostd fixes a session\'s participants at creation, ' +
        'so every signer must be listed before it exists',
    );
  }
  const stored = await getOrCreateRelayIdentity(ceremonyId);
  const identity = await buildRelayIdentity(stored, peerKeys);
  return new FrostdRelayClient(relayUrl, identity);
}

export async function openRelayRoom(
  relayUrl: string,
  threshold: number,
  maxSigners: number,
  ttlSec: number,
  ceremonyId: string,
  peerKeys: string[],
): Promise<RelaySession> {
  const relay = await clientFor(relayUrl, ceremonyId, peerKeys);
  const room = await relay.createRoom(threshold, maxSigners, ttlSec);
  const participantId = new Uint8Array(32);
  crypto.getRandomValues(participantId);
  return { relay, roomCode: room.roomCode, participantId, abort: new AbortController() };
}

/** joiner variant — connects to an existing session by id (no createRoom). */
export async function openJoinerSession(
  relayUrl: string,
  roomCode: string,
  ceremonyId: string,
  peerKeys: string[],
): Promise<RelaySession> {
  const relay = await clientFor(relayUrl, ceremonyId, peerKeys);
  const participantId = new Uint8Array(32);
  crypto.getRandomValues(participantId);
  return { relay, roomCode, participantId, abort: new AbortController() };
}

export interface PeerBuckets {
  /** peerCommits[actionIdx][peerIdx] */
  peerCommits: string[][];
  /** peerShares[actionIdx][peerIdx] */
  peerShares: string[][];
}

/** subscribe to room and bucket peer messages by tag + action index. */
export function subscribePeers(
  s: RelaySession,
  numActions: number,
  onCommitsCount?: (n: number) => void,
  onSign?: (
    sighash: string,
    alphas: string[],
    recipient: string,
    amountZat: string,
    feeZat: string,
    pcztHex?: string,
  ) => void,
): PeerBuckets {
  const peerCommits: string[][] = Array.from({ length: numActions }, () => []);
  const peerShares: string[][] = Array.from({ length: numActions }, () => []);
  void s.relay.joinRoom(
    s.roomCode,
    s.participantId,
    event => {
      if (event.type !== 'message') {
        return;
      }
      const text = new TextDecoder().decode(event.message.payload);
      const sg = /^SIGN:([0-9a-fA-F]+):([^:]+):([^:]+):(\d+):(\d+)(?::([0-9a-fA-F]+))?$/.exec(text);
      if (sg) {
        onSign?.(sg[1]!, sg[2]!.split(','), sg[3]!, sg[4]!, sg[5]!, sg[6]);
        return;
      }
      const cm = /^C:([\s\S]*)$/.exec(text);
      if (cm) {
        const parts = cm[1]!.split('|');
        for (let i = 0; i < parts.length && i < numActions; i++) {
          peerCommits[i]!.push(parts[i]!);
        }
        onCommitsCount?.(peerCommits[0]!.length);
        return;
      }
      const sm = /^S:(\d+):(.+)$/.exec(text);
      if (sm) {
        const idx = Number(sm[1]);
        if (idx >= 0 && idx < numActions) {
          peerShares[idx]!.push(sm[2]!);
        }
      }
    },
    s.abort.signal,
  );
  return { peerCommits, peerShares };
}

export const sendSignPrefix = (
  s: RelaySession,
  sighash: string,
  alphas: string[],
  recipient: string,
  amountZat: string | number,
  feeZat: string,
  pcztHex?: string,
) => {
  const base = `SIGN:${sighash}:${alphas.join(',')}:${recipient}:${amountZat}:${feeZat}`;
  const wire = pcztHex ? `${base}:${pcztHex}` : base;
  return s.relay.sendMessage(s.roomCode, s.participantId, new TextEncoder().encode(wire));
};

export const sendCommitments = (s: RelaySession, ourCommitments: string[]) =>
  s.relay.sendMessage(
    s.roomCode,
    s.participantId,
    new TextEncoder().encode(`C:${ourCommitments.join('|')}`),
  );

export const sendShare = (s: RelaySession, actionIdx: number, share: string) =>
  s.relay.sendMessage(
    s.roomCode,
    s.participantId,
    new TextEncoder().encode(`S:${actionIdx}:${share}`),
  );
