/**
 * group-chat-channel - a persistent chat channel for a multisig group over a
 * dedicated frostd session, separate from any signing ceremony.
 *
 * WHY A DEDICATED SESSION
 *
 * Signing sessions are bounded ceremonies whose payloads the FROST handlers
 * parse; a chat frame sharing that session could wedge a round. A chat frame
 * on its OWN session can never do that. frostd does not enforce message_count
 * or close an active session (every send and receive refreshes a 24h idle
 * timer), so one long-lived session per group is a sound channel. Its per-
 * recipient queue also holds messages for an absent member until they next
 * poll - store-and-forward for free, for up to that day of silence.
 *
 * FINDING THE SESSION AGAIN
 *
 * frostd assigns session ids; members cannot derive a shared one. So we tag
 * the chat session with a sentinel message_count (CHAT_MESSAGE_COUNT, a value
 * signing never uses) and, on open, look through our sessions for the one
 * whose participant set is this exact group and whose count is the sentinel,
 * taking the lexicographically lowest id so every member converges on the same
 * session even if two were created in a race. If none exists we create one.
 * The chosen id is also cached in plain chrome.storage.local (it is a public
 * uuid the relay already knows, not a secret) as a fallback for when the relay
 * cannot enumerate sessions; it is never trusted over a live scan.
 *
 * This class holds NO plaintext history and NO private key beyond the relay
 * identity handed in; sealing is group-chat-crypto's job.
 */

import { FrostdClient } from './frostd-client';
import { sealChatFrame, openChatFrame } from './group-chat-crypto';
import type { RelayIdentity } from './frostd-relay-client';

/** message_count sentinel that marks a session as chat, not a signing round. */
export const CHAT_MESSAGE_COUNT = 255;

const POLL_INTERVAL_MS = 1500;

/**
 * Most frames we will process from one receive() call. The relay controls how
 * many messages it hands back, so a poll must not be a vector for an arbitrarily
 * large parse/decrypt batch.
 */
export const MAX_FRAMES_PER_POLL = 64;

/**
 * An opened, decrypted chat frame. `senderPub` is the sender label the relay
 * attached, which is TRUSTED ONLY to the extent that a successful open proves
 * the frame came from ONE OF THIS PAIR - not which member. See AUTHORSHIP in
 * group-chat-crypto.ts: within a pair the attribution is unauthenticated and
 * deniable; do not treat it as a verified author.
 */
export interface IncomingChatFrame {
  /** hex relay pubkey of the sender; proven to be a member of this pair, not which. */
  senderPub: string;
  /** the frame's plaintext bytes (the caller parses the envelope). */
  payload: Uint8Array;
}

/** hex-lowercased, sorted set-equality for participant lists. */
const sameSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const norm = (xs: string[]) => xs.map(x => x.toLowerCase()).sort();
  const [as, bs] = [norm(a), norm(b)];
  return as.every((x, i) => x === bs[i]);
};

const isUnauthorized = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes('401') || m.includes('Unauthorized') || m.includes('unauthorized');
};

export class GroupChatChannel {
  private readonly client: FrostdClient;
  private readonly identity: RelayIdentity;
  /** this relay identity's private key hex - needed to seal/open chat frames. */
  private readonly privHex: string;
  /** every member of the chat, ourselves included. */
  private readonly members: string[];
  /** lowercased members, for sender-label membership checks on inbound frames. */
  private readonly memberSet: Set<string>;
  private sessionId: string | null = null;
  private loggedIn = false;
  private polling = false;

  constructor(relayUrl: string, identity: RelayIdentity, privateKeyHex: string) {
    this.client = new FrostdClient(relayUrl.replace(/\/$/, ''));
    this.identity = identity;
    this.privHex = privateKeyHex;
    this.members = [identity.publicKey, ...identity.peers];
    this.memberSet = new Set(this.members.map(m => m.toLowerCase()));
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    await this.client.login(this.identity.publicKey, this.identity.sign);
    this.loggedIn = true;
  }

  /** Run `fn`, and if the 1h access token has expired, re-login once and retry. */
  private async withRelogin<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isUnauthorized(e)) {
        throw e;
      }
      this.loggedIn = false;
      await this.ensureLoggedIn();
      return await fn();
    }
  }

  /**
   * Resolve this group's chat session, creating it if none exists. Enumerates
   * every qualifying session and takes the lowest id; `cachedId` is only a
   * fallback for when the relay cannot enumerate. The returned id should be
   * cached by the caller. Idempotent - safe to call on every open.
   */
  async resolveSession(cachedId?: string): Promise<string> {
    await this.ensureLoggedIn();

    // ALWAYS enumerate and take the lexicographically lowest qualifying id.
    // The cached id is a hint at best: a creation race can leave two chat
    // sessions for the same group, and a member that trusted its own cached id
    // would pin to one while its peers pinned to the other, silently never
    // reading each other. Lowest id is the one rule every member can apply.
    let ids: string[] | null = null;
    try {
      ids = await this.withRelogin(() => this.client.listSessions());
    } catch {
      // the relay cannot enumerate us - the cached id is the only way back
      ids = null;
    }

    if (ids !== null) {
      const matches: string[] = [];
      for (const id of ids) {
        try {
          const info = await this.client.getSessionInfo(id);
          if (info.messageCount === CHAT_MESSAGE_COUNT && sameSet(info.pubkeys, this.members)) {
            matches.push(id);
          }
        } catch {
          // a session that vanished mid-scan is not ours to worry about
        }
      }
      if (matches.length > 0) {
        matches.sort();
        const lowest = matches[0]!;
        if (cachedId && cachedId !== lowest && matches.includes(cachedId)) {
          // two chat sessions exist for this group and the cache was pinning us
          // to the higher one: say so loudly, then converge.
          console.warn(
            `group chat: ${matches.length} chat sessions for this group; ` +
              `converging on ${lowest} over cached ${cachedId}`,
          );
        }
        this.sessionId = lowest;
        return lowest;
      }
    } else if (cachedId) {
      // enumeration is unavailable - fall back to the cache if it still checks out
      try {
        const info = await this.withRelogin(() => this.client.getSessionInfo(cachedId));
        if (info.messageCount === CHAT_MESSAGE_COUNT && sameSet(info.pubkeys, this.members)) {
          this.sessionId = cachedId;
          return cachedId;
        }
      } catch {
        // gone or not ours - fall through and create
      }
    }

    // none exists - create it. members include ourselves so we can receive.
    const id = await this.withRelogin(() =>
      this.client.createSession(this.members, CHAT_MESSAGE_COUNT),
    );
    this.sessionId = id;
    return id;
  }

  /** Seal `payload` to every peer and send it on the chat session. */
  async send(payload: Uint8Array): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      throw new Error('group chat: resolveSession must run before send');
    }
    await this.ensureLoggedIn();
    for (const peer of this.identity.peers) {
      const sealed = await sealChatFrame(this.privHex, peer, sessionId, payload);
      await this.withRelogin(() => this.client.send(sessionId, [peer], sealed));
    }
  }

  /**
   * Drain queued frames once and return the ones we can open. A frame whose
   * relay-reported `sender` is not one of this chat's members is dropped before
   * we touch the key: an attacker keypair (a,A) satisfies x25519(a, ourPub) ==
   * pairKey(ourPriv, A), so a relay that supplies an arbitrary sender label
   * could otherwise inject a frame that opens. Membership is the only thing the
   * label is allowed to establish here. Undecryptable frames are dropped too.
   */
  async drain(): Promise<IncomingChatFrame[]> {
    const sessionId = this.sessionId;
    if (sessionId === null) {
      throw new Error('group chat: resolveSession must run before drain');
    }
    const msgs = await this.withRelogin(() => this.client.receive(sessionId, false));
    if (msgs.length > MAX_FRAMES_PER_POLL) {
      console.warn(
        `group chat: relay returned ${msgs.length} frames; handling ${MAX_FRAMES_PER_POLL} this poll`,
      );
    }
    const out: IncomingChatFrame[] = [];
    for (const m of msgs.slice(0, MAX_FRAMES_PER_POLL)) {
      if (!this.memberSet.has(m.sender.toLowerCase())) {
        // not a key we ever sealed to - the relay invented this sender
        continue;
      }
      try {
        const payload = await openChatFrame(this.privHex, m.sender, sessionId, m.msg);
        out.push({ senderPub: m.sender, payload });
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Poll for frames until aborted, handing each non-empty batch to `onFrames`.
   * A whole drain is one batch so the caller can persist once per poll rather
   * than once per message. Poll only while the thread is open - there is no
   * background poller, because an MV3 service worker sleeps and would rebuild
   * the mailbox badly.
   */
  async poll(
    onFrames: (frames: IncomingChatFrame[]) => void,
    signal: AbortSignal,
    onPoll?: (ok: boolean) => void,
  ): Promise<void> {
    this.polling = true;
    while (this.polling && !signal.aborted) {
      let frames: IncomingChatFrame[] = [];
      let ok = true;
      try {
        frames = await this.drain();
      } catch {
        // a transient relay error should not kill the thread; back off and
        // retry. onPoll lets the caller surface a persistently failing thread
        // rather than leaving it silently stuck on "live".
        ok = false;
      }
      if (frames.length > 0) {
        onFrames(frames);
      }
      onPoll?.(ok);
      if (signal.aborted) {
        break;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  stop(): void {
    this.polling = false;
  }
}
