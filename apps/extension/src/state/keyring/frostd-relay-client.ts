/**
 * frostd-relay-client — the old FrostRelayClient shape, backed by a standard
 * frostd relay and Noise_K end-to-end encryption.
 *
 * WHY AN ADAPTER RATHER THAN A REWRITE
 *
 * The relay is touched from five files across ~150 lines: the DKG state
 * slice, the signing protocol, and three routed pages. Rewriting all of that
 * at once, against a transport nothing has exercised in this codebase yet, is
 * a good way to break multisig quietly. Keeping the method shape means those
 * call sites stay as they are and the change under review is this one file.
 *
 * WHAT CHANGES ANYWAY, AND WHY IT HAS TO
 *
 * The old model was a room code: three words, anyone who has them joins, and
 * participants are discovered as they arrive. frostd does not work that way —
 * a session lists its participants' public keys at creation and admits nobody
 * else.
 *
 * That is a real UX cost: everyone must exchange relay public keys before a
 * session exists, where before they exchanged a short code. It is also a real
 * security gain, and the reason not to fight it: a three-word code from a
 * 256-word list is about 2^24 possibilities, and anyone who guessed one could
 * previously JOIN A DKG AS A PARTICIPANT. Under frostd an unlisted key cannot
 * send or receive at all.
 *
 * WHAT THIS FIXES
 *
 * Every payload is sealed with Noise_K before it reaches the relay. The old
 * path sent FROST traffic as a colon-delimited plaintext string — including
 * `SIGN:sighash:alphas:recipient:amount:fee:pczt` — while the transport
 * picker told users the relay "never sees keys or amounts". It did see them.
 * Now it sees ciphertext, and that sentence is true.
 */

import { FrostdClient, type FrostdMessage } from './frostd-client';

/** Kept identical to the old client's so call sites do not change. */
export interface FrostRoom {
  roomCode: string;
  expiresAt: number;
}

export interface FrostParticipant {
  participantId: Uint8Array;
  participantCount: number;
  maxSigners: number;
}

export interface FrostMessage {
  senderId: Uint8Array;
  payload: Uint8Array;
  sequence: number;
}

export type RoomEvent =
  | { type: 'joined'; participant: FrostParticipant }
  | { type: 'message'; message: FrostMessage }
  | { type: 'closed'; reason: string };

/** The Noise_K cipher from the wasm bundle. */
export interface RelayCipher {
  encrypt(recipientHex: string, msg: Uint8Array): string;
  decrypt(senderHex: string, msgHex: string): Uint8Array;
  free?(): void;
}

/** This participant's relay identity plus everyone else's public keys. */
export interface RelayIdentity {
  /** our public key, hex — what frostd authenticates us as */
  publicKey: string;
  /** signs the frostd login challenge; the private key stays with the caller */
  sign: (challenge: string) => Promise<Uint8Array>;
  /** every OTHER participant's public key, hex */
  peers: string[];
  /** Noise_K sessions against those peers, from the wasm bundle */
  cipher: RelayCipher;
}

const POLL_INTERVAL_MS = 700;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export class FrostdRelayClient {
  private readonly client: FrostdClient;
  private readonly identity: RelayIdentity;
  private sessionId: string | null = null;
  private loggedIn = false;
  private polling = false;
  private sequence = 0;
  private pendingEvents: RoomEvent[] = [];

  constructor(serverUrl: string, identity: RelayIdentity) {
    this.client = new FrostdClient(serverUrl.replace(/\/$/, ''));
    this.identity = identity;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    await this.client.login(this.identity.publicKey, this.identity.sign);
    this.loggedIn = true;
  }

  /**
   * Create a session. The returned `roomCode` is frostd's session id — a
   * uuid rather than three words, and the thing to hand to the others.
   *
   * threshold and maxSigners are accepted for call-site compatibility;
   * frostd does not model them, the FROST layer does.
   */
  async createRoom(_threshold: number, _maxSigners: number, _ttlSeconds = 0): Promise<FrostRoom> {
    await this.ensureLoggedIn();
    // every participant, ourselves included — a coordinator that is also
    // signing must be able to send and receive
    const pubkeys = [this.identity.publicKey, ...this.identity.peers];
    const sessionId = await this.client.createSession(pubkeys, 3);
    this.sessionId = sessionId;
    return { roomCode: sessionId, expiresAt: 0 };
  }

  /**
   * Join a session and start delivering events.
   *
   * frostd is poll-based, not push, so this drains the queue on an interval
   * until aborted. That is a change in shape but not in behaviour: the
   * callback still receives messages in arrival order.
   */
  async joinRoom(
    roomCode: string,
    _participantId: Uint8Array,
    onEvent: (event: RoomEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const ev of this.pendingEvents) {
      onEvent(ev);
    }
    this.pendingEvents = [];

    await this.ensureLoggedIn();
    this.sessionId = roomCode;

    // Report ourselves as joined so call sites waiting on this event proceed.
    // frostd has no join notification: membership was decided at creation.
    onEvent({
      type: 'joined',
      participant: {
        participantId: hexToBytes(this.identity.publicKey),
        participantCount: this.identity.peers.length + 1,
        maxSigners: this.identity.peers.length + 1,
      },
    });

    this.polling = true;
    while (this.polling && !signal?.aborted) {
      let msgs: FrostdMessage[] = [];
      try {
        msgs = await this.client.receive(roomCode, false);
      } catch (e) {
        onEvent({ type: 'closed', reason: e instanceof Error ? e.message : String(e) });
        this.polling = false;
        return;
      }

      for (const m of msgs) {
        let payload: Uint8Array;
        try {
          payload = this.identity.cipher.decrypt(m.sender, m.msg);
        } catch {
          // A message we cannot open is not fatal on its own — it may be
          // addressed to someone else — but it must not be handed upward as
          // if it were plaintext.
          continue;
        }
        onEvent({
          type: 'message',
          message: {
            senderId: hexToBytes(m.sender),
            payload,
            sequence: this.sequence++,
          },
        });
      }

      if (signal?.aborted) {
        break;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  /** Encrypt to every peer and send. Returns 0, as the old client did. */
  async sendMessage(
    _roomCode: string,
    _senderId: Uint8Array,
    payload: Uint8Array,
  ): Promise<number> {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      throw new Error('frostd relay: not in a session');
    }
    await this.ensureLoggedIn();

    for (const peer of this.identity.peers) {
      const sealed = this.identity.cipher.encrypt(peer, payload);
      await this.client.send(sessionId, [peer], sealed);
    }
    return 0;
  }

  disconnect(): void {
    this.polling = false;
    // best effort; a closed session is tidiness, not correctness
    if (this.sessionId !== null && this.loggedIn) {
      void this.client.closeSession(this.sessionId).catch(() => undefined);
    }
    this.sessionId = null;
  }
}
