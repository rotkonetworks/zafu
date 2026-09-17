/**
 * @zafu/protocol - the zafu_* dapp message contract.
 *
 * This module is the single source of truth for the request/response shapes a
 * zafu wallet accepts from a website and the SDK (@zafu/zid) that talks to it.
 * BOTH sides import these types, so a field that changes on one side without
 * the other is a compile error rather than a silent runtime failure. The
 * shapes here describe the wire FAITHFULLY - including the historical
 * inconsistencies between handlers (some reply `{ success, ... }`, some reply a
 * bare success object or `{ error }`). An SDK is expected to normalise those
 * into a clean typed surface; the protocol's job is to describe what actually
 * crosses the wire, not to pretend it is uniform. Unifying the envelope is a
 * v2 change (see version.ts).
 *
 * Only IMPLEMENTED, safe-for-arbitrary-origins methods live in v1. Deliberately
 * excluded: the FROST/multisig methods (fund-safety surface, gated behind
 * explicit capabilities - not for a general SDK), and `zafu_send_invite`
 * (an unimplemented stub in the wallet today).
 */

/** lowercase hex, no 0x prefix. */
export type Hex = string;
/** standard base64 (btoa/atob alphabet). */
export type Base64 = string;

/** the uniform error shape a handler returns when a call is refused or fails. */
export interface ZafuError {
  error: string;
}

// -- discovery ---------------------------------------------------------------

/** handshake: detect a zafu wallet and negotiate the protocol version. */
export interface ZafuPingRequest {
  type: 'ping';
}
export interface ZafuPingResponse {
  zafu: true;
  /** the wallet's own release version (chrome.runtime manifest version). */
  version: string;
  /** the wire-protocol major the wallet speaks - see ZAFU_PROTOCOL_VERSION. */
  protocolVersion: number;
}

// -- identity ----------------------------------------------------------------

/**
 * Sign an app-supplied challenge with the site-scoped ZID ed25519 key - the
 * "login with zafu" primitive.
 *
 * SECURITY: the signature covers ONLY `challengeHex`. The wallet checks and
 * displays the calling origin but does NOT bind it into the signed bytes. A
 * relying party MUST therefore make the challenge unforgeable and
 * non-replayable itself: sign a fresh server-issued nonce that also commits to
 * the origin/audience (SIWE-style), never a static string. A signature
 * obtained by one site over challenge C is valid at any other site that
 * presents the same C. (A future protocol version may add wallet-side origin
 * attestation; until then this is the relying party's responsibility.)
 */
export interface ZafuSignRequest {
  type: 'zafu_sign';
  /** the challenge bytes to sign, hex-encoded (1-1024 bytes). */
  challengeHex: Hex;
  /** optional human-readable statement shown on the approval screen. */
  statement?: string;
}
export interface ZafuSignResponse {
  success: boolean;
  /** ed25519 signature over the challenge, hex. present when success. */
  signature?: Hex;
  /** the site-scoped ZID ed25519 public key, hex. present when success. */
  publicKey?: Hex;
  error?: string;
}

/** fetch the caller's site-scoped ZID ed25519 public key without signing. */
export interface ZafuZidPubkeyRequest {
  type: 'zafu_zid_pubkey';
}
export type ZafuZidPubkeyResponse = { pubkey: Hex } | ZafuError;

// -- capabilities ------------------------------------------------------------

/**
 * A named permission an origin can hold. The wallet owns the authoritative
 * list; these are the ones relevant to the v1 SDK surface. Left open (`string`)
 * so the wallet can add capabilities without a protocol bump.
 */
export type ZafuCapability = 'connect' | 'sign_identity' | 'encrypt' | 'frost' | (string & {});

/** request a capability from the wallet (may open an approval popup). */
export interface ZafuRequestCapabilityRequest {
  type: 'zafu_request_capability';
  capability: ZafuCapability;
}
export type ZafuRequestCapabilityResponse =
  | { granted: true; capability: ZafuCapability }
  | { granted: false; denied?: boolean; capability: ZafuCapability }
  | ZafuError;

// -- encryption (sealed box: x25519 DH -> HKDF-SHA256 -> AES-256-GCM) ---------

/** encrypt `plaintext` to a recipient's ZID ed25519 pubkey (sealed box). */
export interface ZafuEncryptRequest {
  type: 'zafu_encrypt';
  /** recipient ZID ed25519 pubkey, 64 hex chars (32 bytes). */
  recipient: Hex;
  /** message to seal, base64. */
  plaintext: Base64;
}
export type ZafuEncryptResponse =
  | {
      /** sealed ciphertext, base64 (includes the 12-byte GCM nonce prefix). */
      ciphertext: Base64;
      /** the ephemeral x25519 public key, hex - the recipient needs it to open. */
      ephemeral_pubkey: Hex;
    }
  | ZafuError;

/** decrypt a sealed box addressed to the caller's site-scoped ZID key. */
export interface ZafuDecryptRequest {
  type: 'zafu_decrypt';
  /** sealed ciphertext, base64 (12-byte nonce prefix + ciphertext). */
  ciphertext: Base64;
  /** the sender's ephemeral x25519 public key, hex. */
  ephemeral_pubkey: Hex;
}
export type ZafuDecryptResponse = { plaintext: Base64 } | ZafuError;

// -- contacts ----------------------------------------------------------------

/**
 * One picked contact. `handle` is an app-scoped opaque identifier (a BLAKE2b
 * derivation over the contact's pubkey and the calling app origin) - stable for
 * this app, unlinkable across apps. `displayName` is the wallet-local name.
 */
export interface ZafuContact {
  handle: string;
  displayName: string;
}

/** open the wallet's contact picker; returns the contacts the user chose. */
export interface ZafuPickContactsRequest {
  type: 'zafu_pick_contacts';
  /** shown on the picker so the user knows why the app wants contacts. */
  purpose?: string;
  /** maximum number the user may select (default 1). */
  max?: number;
}
export type ZafuPickContactsResponse = { success: true; contacts: ZafuContact[] } | ZafuError;

// -- the registry ------------------------------------------------------------

/**
 * The v1 method map: method name -> its request and response types. This is the
 * shared shape both the wallet handlers and the SDK are checked against.
 */
export interface ZafuApi {
  ping: { request: ZafuPingRequest; response: ZafuPingResponse };
  zafu_sign: { request: ZafuSignRequest; response: ZafuSignResponse };
  zafu_zid_pubkey: { request: ZafuZidPubkeyRequest; response: ZafuZidPubkeyResponse };
  zafu_request_capability: {
    request: ZafuRequestCapabilityRequest;
    response: ZafuRequestCapabilityResponse;
  };
  zafu_encrypt: { request: ZafuEncryptRequest; response: ZafuEncryptResponse };
  zafu_decrypt: { request: ZafuDecryptRequest; response: ZafuDecryptResponse };
  zafu_pick_contacts: { request: ZafuPickContactsRequest; response: ZafuPickContactsResponse };
}

export type ZafuMethod = keyof ZafuApi;
export type ZafuRequest<M extends ZafuMethod = ZafuMethod> = ZafuApi[M]['request'];
export type ZafuResponse<M extends ZafuMethod = ZafuMethod> = ZafuApi[M]['response'];

/** true if the given response is the error shape (narrows the union). */
export const isZafuError = (r: unknown): r is ZafuError =>
  typeof r === 'object' && r !== null && 'error' in r && typeof (r as ZafuError).error === 'string';

/**
 * The v1 method names as a runtime array - the anchor the contract test checks
 * the wallet's live handlers against. Kept in lockstep with ZafuApi by the
 * compile-time assertion below.
 */
export const ZAFU_V1_METHODS = [
  'ping',
  'zafu_sign',
  'zafu_zid_pubkey',
  'zafu_request_capability',
  'zafu_encrypt',
  'zafu_decrypt',
  'zafu_pick_contacts',
] as const satisfies readonly ZafuMethod[];

// Compile-time guarantee that ZAFU_V1_METHODS lists EVERY key of ZafuApi (not
// just valid ones). If a method is added to ZafuApi but not to the array, the
// Exclude is a non-never type and this assignment fails to typecheck.
type MissingFromRuntimeList = Exclude<ZafuMethod, (typeof ZAFU_V1_METHODS)[number]>;
const _everyMethodListed: MissingFromRuntimeList extends never ? true : never = true;
void _everyMethodListed;
