/**
 * FROST multisig coordination over a PeerConnection.
 *
 * This module provides the protocol layer for running FROST
 * (Flexible Round-Optimized Schnorr Threshold) DKG and signing
 * rounds over a WebRTC DataChannel. The actual cryptographic
 * operations are delegated to the WASM FROST implementation —
 * this layer only handles message routing between participants.
 *
 * Flow:
 *   1. Two peers connect via WebRTC (through inbox signaling)
 *   2. They run DKG (Distributed Key Generation) to create a shared key
 *   3. The resulting key shares are stored locally
 *   4. When signing, they exchange FROST round messages over DataChannel
 *   5. The combined signature is a valid Schnorr signature
 */

import type { PeerConnection } from './connection';
import type { PeerMessage, FrostKeygenMessage, FrostSignMessage } from './types';

export type FrostRole = 'initiator' | 'responder';

export interface FrostSession {
  /** Session identifier shared between participants. */
  sessionId: string;
  /** Our participant index (1-indexed). */
  participantId: number;
  /** Total number of participants. */
  totalParticipants: number;
  /** Threshold required to sign. */
  threshold: number;
}

export interface FrostKeygenResult {
  /** Hex-encoded group public key (the multisig address key). */
  groupPublicKey: string;
  /** Hex-encoded secret key share (store securely!). */
  secretShare: string;
  /** Hex-encoded public key share for verification. */
  publicShare: string;
}

export interface FrostSignResult {
  /** Hex-encoded combined Schnorr signature. */
  signature: string;
}

/**
 * Coordinate a FROST DKG over an open PeerConnection.
 *
 * Returns a promise that resolves with the keygen result after
 * all rounds complete. The caller provides round handler functions
 * that perform the actual crypto (via WASM).
 */
export async function frostKeygen(
  peer: PeerConnection,
  session: FrostSession,
  handlers: {
    /** Generate round 1 commitment. Returns hex data to send. */
    round1: () => Promise<string>;
    /** Process remote round 1, generate round 2 package. */
    round2: (remoteRound1: string) => Promise<string>;
    /** Process remote round 2, finalize keygen. */
    round3: (remoteRound2: string) => Promise<FrostKeygenResult>;
  },
): Promise<FrostKeygenResult> {
  return new Promise((resolve, reject) => {
    let currentRound = 0;

    const handleMessage = async (msg: PeerMessage) => {
      if (msg.type !== 'frost-keygen') return;
      const keygen = msg.payload as FrostKeygenMessage;

      try {
        if (keygen.round === 1 && currentRound === 1) {
          currentRound = 2;
          const round2Data = await handlers.round2(keygen.data);
          peer.send({
            type: 'frost-keygen',
            payload: {
              round: 2,
              participantId: session.participantId,
              data: round2Data,
            } satisfies FrostKeygenMessage,
          });
        } else if (keygen.round === 2 && currentRound === 2) {
          currentRound = 3;
          const result = await handlers.round3(keygen.data);
          peer.off('message', handleMessage);
          resolve(result);
        }
      } catch (err) {
        peer.off('message', handleMessage);
        reject(err);
      }
    };

    peer.on('message', handleMessage);

    // kick off round 1
    (async () => {
      try {
        currentRound = 1;
        const round1Data = await handlers.round1();
        peer.send({
          type: 'frost-keygen',
          payload: {
            round: 1,
            participantId: session.participantId,
            data: round1Data,
          } satisfies FrostKeygenMessage,
        });
      } catch (err) {
        peer.off('message', handleMessage);
        reject(err);
      }
    })();
  });
}

/**
 * Coordinate a FROST signing round over an open PeerConnection.
 *
 * Both participants must have completed DKG and hold their key shares.
 */
export async function frostSign(
  peer: PeerConnection,
  session: FrostSession,
  context: string,
  handlers: {
    /** Generate round 1 nonce commitment. Returns hex data to send. */
    round1: () => Promise<string>;
    /** Process remote nonces, produce signature share. */
    round2: (remoteRound1: string) => Promise<string>;
    /** Aggregate signature shares into final signature. */
    aggregate: (remoteRound2: string) => Promise<FrostSignResult>;
  },
): Promise<FrostSignResult> {
  return new Promise((resolve, reject) => {
    let currentRound = 0;

    const handleMessage = async (msg: PeerMessage) => {
      if (msg.type !== 'frost-sign') return;
      const sign = msg.payload as FrostSignMessage;
      if (sign.context !== context) return;

      try {
        if (sign.round === 1 && currentRound === 1) {
          currentRound = 2;
          const round2Data = await handlers.round2(sign.data);
          peer.send({
            type: 'frost-sign',
            payload: {
              round: 2,
              participantId: session.participantId,
              context,
              data: round2Data,
            } satisfies FrostSignMessage,
          });
        } else if (sign.round === 2 && currentRound === 2) {
          const result = await handlers.aggregate(sign.data);
          peer.off('message', handleMessage);
          resolve(result);
        }
      } catch (err) {
        peer.off('message', handleMessage);
        reject(err);
      }
    };

    peer.on('message', handleMessage);

    (async () => {
      try {
        currentRound = 1;
        const round1Data = await handlers.round1();
        peer.send({
          type: 'frost-sign',
          payload: {
            round: 1,
            participantId: session.participantId,
            context,
            data: round1Data,
          } satisfies FrostSignMessage,
        });
      } catch (err) {
        peer.off('message', handleMessage);
        reject(err);
      }
    })();
  });
}
