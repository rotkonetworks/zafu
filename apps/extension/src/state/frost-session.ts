/**
 * frost-session — DKG and signing session coordinator
 *
 * manages the interactive FROST rounds via the relay.
 * WASM handles crypto, relay handles transport, this handles state.
 */

import { AllSlices, SliceCreator } from '.';
import { FrostdRelayClient, type RoomEvent } from './keyring/frostd-relay-client';
import { buildRelayIdentity, getOrCreateRelayIdentity } from './keyring/relay-identity';
import type { DkgSession, SigningSession } from './keyring/multisig-types';

/**
 * Total time budget for a FROST DKG or signing session, end-to-end.
 *
 * This is a single deadline that spans the whole interactive flow —
 * waiting for peers to join, exchanging round messages, finalizing.
 * Each individual `waitForUntil` call eats from this same budget; the
 * session aborts whenever the deadline is hit, regardless of which
 * step is currently waiting.
 *
 * 10 min comfortably covers humans coordinating room codes out of
 * band (chat, DM, copy-paste). Network round-trips for DKG messages
 * are sub-second on a healthy relay, so the bulk of this budget is
 * spent on people, not bytes.
 */
export const FROST_SESSION_TIMEOUT_MS = 10 * 60_000;

/**
 * Wait for `condition` to become true, or until `deadline` (ms epoch).
 * Throws on timeout. Pass the same `deadline` to every wait in a
 * session so the cumulative budget is enforced rather than each wait
 * getting its own fresh timeout.
 */
export const waitForUntil = (
  condition: () => boolean,
  deadline: number,
  pollMs = 100,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        clearInterval(iv);
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(iv);
        reject(new Error('frost session timed out'));
      }
    };
    const iv = setInterval(tick, pollMs);
    tick();
  });

export interface FrostSessionSlice {
  /** active DKG session (null when not in DKG) */
  dkg: DkgSession | null;
  /** active signing session (null when not signing) */
  signing: SigningSession | null;
  /** relay client instance */
  relay: FrostdRelayClient | null;
  /**
   * This ceremony's relay identity: a fresh id per ceremony, so a relay
   * operator cannot link a user's sessions to each other.
   */
  relayCeremonyId: string | null;
  /** our relay public key, hex — the thing to hand to the other signers */
  relayPublicKey: string | null;

  /**
   * Create this ceremony's relay identity and return our public key.
   *
   * Must run before startDkg/joinDkg: frostd fixes a session's participants
   * at creation, so everyone has to exchange keys first. Separate from those
   * calls because the user needs their own key to share before they can know
   * anyone else's.
   */
  prepareRelayIdentity: () => Promise<string>;

  /** start a new DKG as coordinator — creates the session, runs round 1 */
  startDkg: (
    relayUrl: string,
    threshold: number,
    maxSigners: number,
    peerKeys: string[],
  ) => Promise<string>;
  /** join an existing DKG session — runs round 1 */
  joinDkg: (
    relayUrl: string,
    roomCode: string,
    threshold: number,
    maxSigners: number,
    peerKeys: string[],
  ) => Promise<void>;
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
    peerKeys?: string[],
  ) => Promise<string>;
  /** join a signing session */
  joinSigning: (
    relayUrl: string,
    roomCode: string,
    sighashHex: string,
    alphasHex: string[],
    keyPackageHex: string,
    ephemeralSeedHex: string,
    peerKeys?: string[],
  ) => Promise<void>;
  /** process incoming signing events from relay */
  handleSigningEvent: (event: RoomEvent) => void;
  /** reset signing state */
  resetSigning: () => void;
}

/**
 * Build a relay client for this ceremony's identity.
 *
 * Throws rather than generating an identity on the fly: doing that here would
 * produce a key the peers have never seen, and frostd would reject it with a
 * membership error that says nothing about the real cause.
 */
const buildRelayClient = async (
  get: () => AllSlices,
  relayUrl: string,
  peerKeys: string[],
): Promise<FrostdRelayClient> => {
  const ceremonyId = get().frostSession.relayCeremonyId;
  if (ceremonyId === null) {
    throw new Error('call prepareRelayIdentity and exchange keys before starting a session');
  }
  if (peerKeys.length === 0) {
    throw new Error('no peer relay keys: every signer must be listed before the session exists');
  }
  const stored = await getOrCreateRelayIdentity(ceremonyId);
  const identity = await buildRelayIdentity(stored, peerKeys);
  return new FrostdRelayClient(relayUrl, identity);
};

export const createFrostSessionSlice = (): SliceCreator<FrostSessionSlice> => (set, get) => ({
  dkg: null,
  signing: null,
  relay: null,
  relayCeremonyId: null,
  relayPublicKey: null,

  prepareRelayIdentity: async () => {
    const existing = get().frostSession.relayPublicKey;
    if (existing !== null) {
      return existing;
    }
    const ceremonyId = crypto.randomUUID();
    const stored = await getOrCreateRelayIdentity(ceremonyId);
    set(state => {
      state.frostSession.relayCeremonyId = ceremonyId;
      state.frostSession.relayPublicKey = stored.publicKey;
    });
    return stored.publicKey;
  },

  startDkg: async (relayUrl, threshold, maxSigners, peerKeys) => {
    const relay = await buildRelayClient(get, relayUrl, peerKeys);
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

  joinDkg: async (relayUrl, roomCode, threshold, maxSigners, peerKeys) => {
    const relay = await buildRelayClient(get, relayUrl, peerKeys);

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

  handleDkgEvent: event => {
    const { dkg } = get().frostSession;
    if (!dkg) {
      return;
    }

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

  startSigning: async (
    relayUrl,
    sighashHex,
    alphasHex,
    _keyPackageHex,
    _ephemeralSeedHex,
    peerKeys = [],
    threshold = 2,
    maxSigners = 3,
  ) => {
    const relay = await buildRelayClient(get, relayUrl, peerKeys);
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

  joinSigning: async (
    relayUrl,
    roomCode,
    sighashHex,
    alphasHex,
    _keyPackageHex,
    _ephemeralSeedHex,
    peerKeys = [],
  ) => {
    const relay = await buildRelayClient(get, relayUrl, peerKeys);

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

  handleSigningEvent: event => {
    const { signing } = get().frostSession;
    if (!signing) {
      return;
    }

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
