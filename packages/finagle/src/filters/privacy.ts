/**
 * Privacy filter for the message pipeline.
 *
 * Controls how your identity appears to the relay.
 * The relay sees participant_id — this filter controls what that is.
 *
 * Three modes:
 *   normal:   hash(zafu_pubkey) — persistent, linkable across sessions
 *   private:  random per session — ephemeral, unlinkable between sessions
 *   paranoid: random per message — unlinkable between messages
 *
 * Your real nick is inside the encrypted message payload.
 * The relay can't read it (if encryption is enabled).
 * The relay only sees the participant_id, which this filter controls.
 */

export type PrivacyMode = 'normal' | 'private' | 'paranoid';

export interface PrivacyIdentity {
  /** what the relay sees as your participant_id */
  participantId: Uint8Array;
  /** your real nick (inside encrypted payload, invisible to relay) */
  nick: string;
  /** current mode */
  mode: PrivacyMode;
}

/** Generate a participant ID based on privacy mode. */
export class PrivacyProvider {
  private mode: PrivacyMode;
  private sessionId: Uint8Array;
  private realNick: string;
  private publicKey: Uint8Array | null;

  constructor(mode: PrivacyMode = 'private') {
    this.mode = mode;
    this.sessionId = randomBytes(32);
    this.realNick = '';
    this.publicKey = null;
  }

  /** set the real identity (from zafu login) */
  setIdentity(nick: string, publicKey?: Uint8Array): void {
    this.realNick = nick;
    this.publicKey = publicKey ?? null;
  }

  /** set privacy mode */
  setMode(mode: PrivacyMode): void {
    this.mode = mode;
    // regenerate session ID on mode change
    if (mode !== 'normal') {
      this.sessionId = randomBytes(32);
    }
  }

  /** get current mode */
  getMode(): PrivacyMode {
    return this.mode;
  }

  /** get the participant ID to send to the relay */
  getParticipantId(): Uint8Array {
    switch (this.mode) {
      case 'normal':
        // deterministic from public key — linkable across sessions
        if (this.publicKey) return this.publicKey;
        return this.sessionId; // fallback if no wallet
      case 'private':
        // random per session — new identity each time you open zitadel
        return this.sessionId;
      case 'paranoid':
        // random per call — new identity per message
        return randomBytes(32);
    }
  }

  /** get the participant ID as hex string */
  getParticipantIdHex(): string {
    return toHex(this.getParticipantId());
  }

  /** get full identity state */
  getIdentity(): PrivacyIdentity {
    return {
      participantId: this.getParticipantId(),
      nick: this.realNick,
      mode: this.mode,
    };
  }

  /** status string for display */
  statusText(): string {
    switch (this.mode) {
      case 'normal': return 'normal (relay can link sessions)';
      case 'private': return 'private (new ID per session)';
      case 'paranoid': return 'paranoid (new ID per message)';
    }
  }
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
