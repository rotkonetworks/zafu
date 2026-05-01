// wire-tags used by both self-custody and airgap multisig signers on the relay:
//   SIGN:<sighash>:<alphas>:<recipient>:<amountZat>:<feeZat>[:<unsignedTxHex>]
//                                                              — joiner display payload + verifier bytes
//   C:<commit_a0>|<commit_a1>|...                              — round-1 commitments per action
//   S:<actionIdx>:<share>                                      — round-2 share per action
//
// `unsignedTxHex` is optional: hosts on the new client publish it so each
// joiner can OVK-decrypt the bundle locally and refuse to sign if the
// derived (recipient, amount) disagrees with the host's claim. Old hosts
// omit it; joiners then fall back to host-claim-only with a warning.

import { FrostRelayClient } from '../../../../state/keyring/frost-relay-client';

export interface RelaySession {
  relay: FrostRelayClient;
  roomCode: string;
  participantId: Uint8Array;
  abort: AbortController;
}

export async function openRelayRoom(
  relayUrl: string,
  threshold: number,
  maxSigners: number,
  ttlSec: number,
): Promise<RelaySession> {
  const relay = new FrostRelayClient(relayUrl);
  const room = await relay.createRoom(threshold, maxSigners, ttlSec);
  const participantId = new Uint8Array(32);
  crypto.getRandomValues(participantId);
  return { relay, roomCode: room.roomCode, participantId, abort: new AbortController() };
}

/** joiner variant — connects to an existing room by code (no createRoom). */
export function openJoinerSession(relayUrl: string, roomCode: string): RelaySession {
  const relay = new FrostRelayClient(relayUrl);
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
    unsignedTxHex?: string,
  ) => void,
): PeerBuckets {
  const peerCommits: string[][] = Array.from({ length: numActions }, () => []);
  const peerShares: string[][] = Array.from({ length: numActions }, () => []);
  void s.relay.joinRoom(s.roomCode, s.participantId, (event) => {
    if (event.type !== 'message') return;
    const text = new TextDecoder().decode(event.message.payload);
    const sg = text.match(/^SIGN:([0-9a-fA-F]+):([^:]+):([^:]+):(\d+):(\d+)(?::([0-9a-fA-F]+))?$/);
    if (sg) {
      onSign?.(sg[1]!, sg[2]!.split(','), sg[3]!, sg[4]!, sg[5]!, sg[6]);
      return;
    }
    const cm = text.match(/^C:([\s\S]*)$/);
    if (cm) {
      const parts = cm[1]!.split('|');
      for (let i = 0; i < parts.length && i < numActions; i++) peerCommits[i]!.push(parts[i]!);
      onCommitsCount?.(peerCommits[0]!.length);
      return;
    }
    const sm = text.match(/^S:(\d+):(.+)$/);
    if (sm) {
      const idx = Number(sm[1]);
      if (idx >= 0 && idx < numActions) peerShares[idx]!.push(sm[2]!);
    }
  }, s.abort.signal);
  return { peerCommits, peerShares };
}

export const sendSignPrefix = (
  s: RelaySession,
  sighash: string,
  alphas: string[],
  recipient: string,
  amountZat: string | number,
  feeZat: string,
  unsignedTxHex?: string,
) => {
  const base = `SIGN:${sighash}:${alphas.join(',')}:${recipient}:${amountZat}:${feeZat}`;
  const wire = unsignedTxHex ? `${base}:${unsignedTxHex}` : base;
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
