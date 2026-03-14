/**
 * Peer-to-peer connection types.
 *
 * Security model:
 *
 *   Signaling flows through encrypted memos (Zcash shielded / Penumbra
 *   encrypted). Only the intended recipient can decrypt the memo, so
 *   the SDP offer (containing the DTLS fingerprint) is authenticated
 *   by the memo encryption layer. No permanent wallet keys are used
 *   in the WebRTC session itself.
 *
 *   Each session generates an ephemeral X25519 keypair. The public key
 *   is included in the signaling envelope. After the DataChannel opens,
 *   both peers verify they hold the ephemeral key advertised in the
 *   memo by signing a challenge. This binds the WebRTC session to the
 *   memo exchange without leaking permanent identity.
 *
 *   Identity leakage:
 *   - To peer: wallet address (already known from conversation) + IP
 *   - To STUN server: IP only (use TURN relay for IP privacy)
 *   - To third parties: nothing (memos are encrypted, DTLS encrypts data)
 *
 * For native/server contexts (zidecar), iroh (QUIC-based) is preferred.
 * WebRTC is used here because it's the only P2P transport in browsers.
 */

/** Signaling message sent via encrypted memo. */
export interface SignalEnvelope {
  __zafu_signal: true;
  /** Unique session ID to correlate offer/answer pairs. */
  sessionId: string;
  type: 'offer' | 'answer' | 'close';
  payload: string; // JSON-encoded SDP or ICE candidate
  /** Ephemeral public key (hex) for session authentication. */
  ephemeralPub?: string;
}

export function isSignalEnvelope(msg: unknown): msg is SignalEnvelope {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    '__zafu_signal' in msg &&
    (msg as SignalEnvelope).__zafu_signal === true
  );
}

/** Parse a memo string for an embedded signal envelope. */
export function parseSignalFromMemo(memo: string): SignalEnvelope | null {
  try {
    const parsed = JSON.parse(memo);
    if (isSignalEnvelope(parsed)) return parsed;
  } catch {
    // not a signal message
  }
  return null;
}

/** Encode a signal envelope for embedding in a memo. */
export function encodeSignalToMemo(signal: SignalEnvelope): string {
  return JSON.stringify(signal);
}

/** Typed message sent over a DataChannel. */
export interface PeerMessage {
  type: string;
  payload: unknown;
}

/** Known peer message types. */
export type PeerMessageType =
  | 'file-offer'     // { name, size, mimeType }
  | 'file-accept'    // {}
  | 'file-chunk'     // { index, data (base64) }
  | 'file-complete'  // { hash }
  | 'frost-keygen'   // FROST DKG round messages
  | 'frost-sign'     // FROST signing round messages
  | 'auth-challenge' // session authentication
  | 'auth-response'  // session authentication
  | 'ping'
  | 'pong';

/** File transfer metadata. */
export interface FileOffer {
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
}

/** FROST key generation round message. */
export interface FrostKeygenMessage {
  round: 1 | 2 | 3;
  participantId: number;
  data: string; // hex-encoded round data
}

/** FROST signing round message. */
export interface FrostSignMessage {
  round: 1 | 2;
  participantId: number;
  /** What is being signed — txid, message hash, etc. */
  context: string;
  data: string; // hex-encoded round data
}

/** Connection state. */
export type PeerState =
  | 'idle'
  | 'signaling'      // offer/answer exchange via memos
  | 'connecting'      // ICE negotiation
  | 'authenticating'  // verifying ephemeral key ownership
  | 'connected'       // DataChannel open + authenticated
  | 'disconnected'
  | 'failed';

/** Events emitted by a PeerConnection. */
export interface PeerEvents {
  stateChange: (state: PeerState) => void;
  message: (msg: PeerMessage) => void;
  /** Signaling messages that need to be sent to the remote peer via memo. */
  signal: (envelope: SignalEnvelope) => void;
  error: (err: Error) => void;
}
