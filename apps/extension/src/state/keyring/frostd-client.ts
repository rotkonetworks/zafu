/**
 * frostd-client — the standard ZF FROST relay, over JSON-HTTP.
 *
 * WHY THIS REPLACES frost-relay-client
 *
 * We have been running our own relay protocols: a gRPC room protocol in
 * zidecar, and a WebSocket one via poker-relay here. Neither is spoken by
 * anything outside this repo, and both carried FROST traffic in the clear.
 *
 * frostd is what the Zcash FROST ecosystem uses. zcli speaks it via ZF's own
 * frost-client crate, zidecar serves ZF's own router, and this is the browser
 * end of the same thing. Nine endpoints, all opaque-byte pass-through.
 *
 * ENCRYPTION IS NOT THIS CLASS'S JOB
 *
 * This class never encrypts, decrypts, or holds a private key. Callers pass
 * ciphertext in and get ciphertext out — encryption is FrostRelayCipher in
 * the wasm bundle, which is asserted byte-compatible with ZF's frost-client
 * in Rust.
 *
 * Keeping them apart is deliberate. The relay is untrusted by design, and a
 * transport class that could see plaintext is one refactor away from logging
 * it.
 */

/** A message as it comes off the relay: still encrypted. */
export interface FrostdMessage {
  /** hex-encoded sender public key */
  sender: string;
  /** hex-encoded ciphertext */
  msg: string;
}

/** Signs the login challenge. The private key stays with the caller. */
export type ChallengeSigner = (challenge: string) => Promise<Uint8Array>;

export class FrostdClient {
  private readonly host: string;
  private accessToken: string | null = null;

  constructor(host: string) {
    this.host = host.replace(/\/$/, '');
  }

  /**
   * Authenticate. frostd issues a challenge, we sign it, and it returns an
   * access token used as a bearer for everything else.
   */
  async login(pubkeyHex: string, sign: ChallengeSigner): Promise<void> {
    const { challenge } = await this.post<{ challenge: string }>('challenge', {});
    const signature = await sign(challenge);
    const { access_token } = await this.post<{ access_token: string }>('login', {
      challenge,
      pubkey: pubkeyHex,
      signature: Array.from(signature),
    });
    this.accessToken = access_token;
  }

  async logout(): Promise<void> {
    await this.post('logout', {});
    this.accessToken = null;
  }

  /**
   * Open a session as coordinator. `messageCount` is how many messages each
   * participant will send; frostd uses it for its own bookkeeping.
   */
  async createSession(peerPubkeysHex: string[], messageCount: number): Promise<string> {
    const { session_id } = await this.post<{ session_id: string }>('create_new_session', {
      pubkeys: peerPubkeysHex,
      message_count: messageCount,
    });
    return session_id;
  }

  async listSessions(): Promise<string[]> {
    const { session_ids } = await this.post<{ session_ids: string[] }>('list_sessions', {});
    return session_ids;
  }

  async getSessionInfo(sessionId: string): Promise<{
    messageCount: number;
    pubkeys: string[];
    coordinatorPubkey: string;
  }> {
    const out = await this.post<{
      message_count: number;
      pubkeys: string[];
      coordinator_pubkey: string;
    }>('get_session_info', { session_id: sessionId });
    return {
      messageCount: out.message_count,
      pubkeys: out.pubkeys,
      coordinatorPubkey: out.coordinator_pubkey,
    };
  }

  /**
   * Send ciphertext. An empty `recipients` addresses the coordinator.
   *
   * `msgHex` must already be encrypted — see the module note.
   */
  async send(sessionId: string, recipientsHex: string[], msgHex: string): Promise<void> {
    await this.post('send', {
      session_id: sessionId,
      recipients: recipientsHex,
      msg: msgHex,
    });
  }

  /** Collect queued ciphertext. Still encrypted; the caller decrypts. */
  async receive(sessionId: string, asCoordinator: boolean): Promise<FrostdMessage[]> {
    const { msgs } = await this.post<{ msgs: FrostdMessage[] }>('receive', {
      session_id: sessionId,
      as_coordinator: asCoordinator,
    });
    return msgs;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.post('close_session', { session_id: sessionId });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    // Everything but the login handshake needs the token. Checking here rather
    // than at each call site means a new endpoint cannot forget to.
    if (this.accessToken === null && path !== 'challenge' && path !== 'login') {
      throw new Error('frostd: not logged in');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken !== null) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const res = await fetch(`${this.host}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Include the body: frostd returns a structured error and swallowing it
      // turns a clear "not in session" into a bare 400.
      const detail = await res.text().catch(() => '');
      throw new Error(`frostd ${path} failed: ${res.status} ${detail}`.trim());
    }

    // Several endpoints return an empty body on success.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
