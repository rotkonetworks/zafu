/**
 * frost-session — DKG and signing session coordinator
 *
 * manages the interactive FROST rounds via the relay.
 * WASM handles crypto, relay handles transport, this handles state.
 */

import { AllSlices, SliceCreator } from '.';
import { FrostRelayClient, type RoomEvent } from './keyring/frost-relay-client';
import type { DkgSession, SigningSession } from './keyring/multisig-types';

export interface FrostSessionSlice {
  /** active DKG session (null when not in DKG) */
  dkg: DkgSession | null;
  /** active signing session (null when not signing) */
  signing: SigningSession | null;
  /** relay client instance */
  relay: FrostRelayClient | null;

  /** start a new DKG as coordinator — creates room, runs round 1 */
  startDkg: (relayUrl: string, threshold: number, maxSigners: number) => Promise<string>;
  /** join an existing DKG room — runs round 1 */
  joinDkg: (relayUrl: string, roomCode: string, threshold: number, maxSigners: number) => Promise<void>;
  /** process incoming DKG events from relay */
  handleDkgEvent: (event: RoomEvent) => void;
  /** advance DKG to next round when enough messages collected */
  advanceDkg: () => Promise<void>;
  /** reset DKG state */
  resetDkg: () => void;

  /** start a signing session — creates room, runs round 1 */
  startSigning: (
    relayUrl: string,
    sighashHex: string,
    alphasHex: string[],
    keyPackageHex: string,
    ephemeralSeedHex: string,
  ) => Promise<string>;
  /** join a signing session */
  joinSigning: (
    relayUrl: string,
    roomCode: string,
    sighashHex: string,
    alphasHex: string[],
    keyPackageHex: string,
    ephemeralSeedHex: string,
  ) => Promise<void>;
  /** process incoming signing events from relay */
  handleSigningEvent: (event: RoomEvent) => void;
  /** reset signing state */
  resetSigning: () => void;
}

export const createFrostSessionSlice = (): SliceCreator<FrostSessionSlice> => (set, get) => ({
  dkg: null,
  signing: null,
  relay: null,

  startDkg: async (relayUrl, threshold, maxSigners) => {
    const relay = new FrostRelayClient(relayUrl);
    const room = await relay.createRoom(threshold, maxSigners, 600);

    set(state => {
      state.frostSession.relay = relay;
      state.frostSession.dkg = {
        roomCode: room.roomCode,
        relayUrl,
        threshold,
        maxSigners,
        round: 0,
        peerBroadcasts: [],
        collectedRound2: [],
        joinedParticipants: [],
      };
    });

    return room.roomCode;
  },

  joinDkg: async (relayUrl, roomCode, threshold, maxSigners) => {
    const relay = new FrostRelayClient(relayUrl);

    set(state => {
      state.frostSession.relay = relay;
      state.frostSession.dkg = {
        roomCode,
        relayUrl,
        threshold,
        maxSigners,
        round: 0,
        peerBroadcasts: [],
        collectedRound2: [],
        joinedParticipants: [],
      };
    });
  },

  handleDkgEvent: (event) => {
    const { dkg } = get().frostSession;
    if (!dkg) return;

    if (event.type === 'joined') {
      set(state => {
        state.frostSession.dkg!.joinedParticipants.push(event.participant.participantId);
      });
    } else if (event.type === 'message') {
      const hex = bytesToHex(event.message.payload);
      const { round } = get().frostSession.dkg!;
      if (round <= 1) {
        set(state => {
          state.frostSession.dkg!.peerBroadcasts.push(hex);
        });
      } else if (round === 2) {
        set(state => {
          state.frostSession.dkg!.collectedRound2.push(hex);
        });
      }
    } else if (event.type === 'closed') {
      set(state => {
        state.frostSession.dkg!.error = `room closed: ${event.reason}`;
      });
    }
  },

  advanceDkg: async () => {
    // DKG advancement happens in the worker via WASM calls.
    // This is a placeholder — the actual round advancement is triggered
    // from the DKG UI component which calls the zcash-worker with
    // the collected messages and gets back the next round's output.
    // See routes/popup/multisig/dkg-flow.tsx for the full orchestration.
  },

  resetDkg: () => {
    set(state => {
      state.frostSession.dkg = null;
    });
  },

  startSigning: async (relayUrl, sighashHex, alphasHex, _keyPackageHex, _ephemeralSeedHex, threshold = 2, maxSigners = 3) => {
    const relay = new FrostRelayClient(relayUrl);
    const room = await relay.createRoom(threshold, maxSigners, 300);

    set(state => {
      state.frostSession.relay = relay;
      state.frostSession.signing = {
        roomCode: room.roomCode,
        relayUrl,
        step: 'round1',
        allCommitments: [],
        sighashHex,
        alphasHex,
        allShares: [],
      };
    });

    return room.roomCode;
  },

  joinSigning: async (relayUrl, roomCode, sighashHex, alphasHex, _keyPackageHex, _ephemeralSeedHex) => {
    const relay = new FrostRelayClient(relayUrl);

    set(state => {
      state.frostSession.relay = relay;
      state.frostSession.signing = {
        roomCode,
        relayUrl,
        step: 'round1',
        allCommitments: [],
        sighashHex,
        alphasHex,
        allShares: [],
      };
    });
  },

  handleSigningEvent: (event) => {
    const { signing } = get().frostSession;
    if (!signing) return;

    if (event.type === 'message') {
      const hex = bytesToHex(event.message.payload);
      const { step } = get().frostSession.signing!;
      if (step === 'collecting-commitments') {
        set(state => {
          state.frostSession.signing!.allCommitments.push(hex);
        });
      } else if (step === 'collecting-shares') {
        set(state => {
          state.frostSession.signing!.allShares.push(hex);
        });
      }
    } else if (event.type === 'closed') {
      set(state => {
        state.frostSession.signing!.error = `room closed: ${event.reason}`;
      });
    }
  },

  resetSigning: () => {
    set(state => {
      state.frostSession.signing = null;
    });
  },
});

export const frostSessionSelector = (state: AllSlices) => state.frostSession;
export const frostDkgSelector = (state: AllSlices) => state.frostSession.dkg;
export const frostSigningSelector = (state: AllSlices) => state.frostSession.signing;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
