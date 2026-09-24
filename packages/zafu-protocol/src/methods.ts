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

/**
 * Machine-readable error codes a wallet MAY set on a ZafuError so a client can
 * branch on the cause without parsing the human-readable `error` string. Open
 * (`string & {}`) so a new code never forces a version bump, and additive: a
 * wallet that predates it omits `code` and the client falls back to the string.
 * These are the WIRE codes the wallet emits; an SDK's own taxonomy (which also
 * has client-side codes like `unavailable`/`transport_error`) is a superset.
 */
export type ZafuWireErrorCode =
  | 'locked' // wallet is locked; the user must unlock
  | 'denied' // the user declined the request
  | 'rate_limited' // the origin exceeded the wallet's rate limit
  | 'not_available' // the feature is turned off in wallet settings
  | 'invalid_request' // the request was malformed
  | 'internal_error' // the wallet failed unexpectedly
  | (string & {});

/** the uniform error shape a handler returns when a call is refused or fails. */
export interface ZafuError {
  error: string;
  /** machine-readable cause; prefer it over parsing `error`. Optional (additive). */
  code?: ZafuWireErrorCode;
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
  /**
   * The wire-protocol major the wallet speaks - see ZAFU_PROTOCOL_VERSION. The
   * highest major it supports; kept for simple clients that only read a scalar.
   */
  protocolVersion: number;
  /**
   * Every wire-protocol major the wallet supports, highest first (QUIC-style
   * version negotiation). Additive over `protocolVersion`: a client that speaks
   * more than one major picks the highest it shares with the wallet. Optional so
   * a client can fall back to the `protocolVersion` scalar; a wallet SHOULD send
   * it. Reserved now so a future major negotiates without a breaking change.
   */
  protocolVersions?: number[];
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
  /** machine-readable cause when success is false; prefer it over `error`. Optional (additive). */
  code?: ZafuWireErrorCode;
}

/** fetch the caller's site-scoped ZID ed25519 public key without signing. */
export interface ZafuZidPubkeyRequest {
  type: 'zafu_zid_pubkey';
}
export type ZafuZidPubkeyResponse =
  | {
      /** the site-scoped ZID ed25519 public key, hex (classical sealed box). */
      pubkey: Hex;
      /**
       * the site's post-quantum sealed-box public key, hex, when the wallet
       * supports it. Pass this back as `recipient_pq` on zafu_encrypt to get a
       * harvest-now-decrypt-later-resistant message. Additive: a wallet that
       * predates PQ omits it and callers fall back to the classical `pubkey`.
       */
      pq_pubkey?: Hex;
      /** the suite of `pq_pubkey` (e.g. 'xwing-v1'), present iff pq_pubkey is. */
      pq_suite?: string;
      /**
       * ed25519 signature (hex) by `pubkey` over the domain-separated tuple
       * (suite || origin || pq_epoch || pq_pubkey), using @zafu/pq's
       * `pqKeyAuthMessage`. Present iff pq_pubkey is. A caller MUST verify this
       * against `pubkey` before sealing to `pq_pubkey`, and MUST NOT fall back
       * to the classical path when it fails - a bad signature means the PQ key
       * was tampered with, not that PQ is unavailable.
       */
      pq_sig?: Hex;
      /**
       * the rotation epoch `pq_pubkey` was derived at (P2 coarse recipient FS).
       * Carry it back as `pq_epoch` on zafu_decrypt so the recipient derives the
       * matching seed. Present iff pq_pubkey is.
       */
      pq_epoch?: number;
      /**
       * the origin the keys were derived and signed for (the requesting dapp's
       * origin). A relying party verifying `pq_sig` MUST rebuild the signed
       * message with THIS origin. Echoed so the (pubkey, pq_sig, origin) bundle
       * is self-contained when relayed to a peer. Present iff pq_pubkey is.
       */
      origin?: string;
    }
  | ZafuError;

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

/** encrypt `plaintext` to a recipient (sealed box). */
export interface ZafuEncryptRequest {
  type: 'zafu_encrypt';
  /** recipient ZID ed25519 pubkey, 64 hex chars (32 bytes) - classical path. */
  recipient: Hex;
  /**
   * recipient post-quantum sealed-box public key (the `pq_pubkey` from
   * zafu_zid_pubkey), hex. When present the wallet seals with the hybrid X-Wing
   * suite (X25519 + ML-KEM-768) so recorded traffic stays confidential against a
   * future quantum attacker. Additive: omit it for the classical path.
   */
  recipient_pq?: Hex;
  /** message to seal, base64. */
  plaintext: Base64;
}
export type ZafuEncryptResponse =
  | {
      /**
       * sealed ciphertext, base64. Classical: 12-byte GCM nonce prefix + AEAD.
       * Hybrid: a suite-tagged, self-contained blob (the X-Wing ciphertext is
       * inside), and `ephemeral_pubkey` is empty.
       */
      ciphertext: Base64;
      /**
       * the ephemeral x25519 public key, hex, for the classical path - the
       * recipient needs it to open. Empty string for the hybrid path (the
       * ephemeral is carried inside the ciphertext).
       */
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
  /**
   * for a hybrid (X-Wing) box: the rotation epoch the recipient's pq_pubkey was
   * advertised at (the `pq_epoch` from zafu_zid_pubkey). The wallet derives the
   * matching seed to open it. Omit (or 0) for the classical path and for legacy
   * hybrid boxes sealed before rotation existed. Additive.
   */
  pq_epoch?: number;
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

// -- contact discovery (opt-in, app-scoped presence) -------------------------

/**
 * Ask the wallet which of MY contacts are present in this app scope this epoch.
 *
 * This is the "is my friend online right now?" primitive. It is deliberately
 * the NARROWEST possible social-graph query, and that narrowness is what makes
 * it safe for arbitrary origins without a per-request approval prompt:
 *
 *   - it reveals ONLY the present intersection - never the contact list, never
 *     who is ABSENT, never the pairwise root secret, never a raw peer pubkey.
 *     A dapp can only learn "a handle I was already given is online now";
 *   - handles are APP-SCOPED (SHA-256 over the contact key + the caller's
 *     origin), so the same contact is an unrelated handle at every other app -
 *     two colluding origins cannot join their results into one graph;
 *   - an origin that holds no handle learns nothing it can attribute, and a
 *     wallet that has not opted in (or has no relay configured, or is locked)
 *     refuses with `not_available` rather than answering.
 *
 * The feature is off unless the user enables it and configures a relay, so a
 * wallet that never opted in answers `not_available` and its behaviour is
 * otherwise byte-identical.
 */
export interface ZafuDiscoverContactsRequest {
  type: 'zafu_discover_contacts';
  /** app scope the request is for (the dapp origin); tags are unlinkable across scopes. */
  appScope: string;
}
export interface ZafuDiscoveredContact {
  /** opaque, app-scoped handle - never the raw pubkey. */
  handle: string;
  /** ephemeral session pubkey to connect to for this epoch. */
  sessionPubHex: Hex;
  /** capability bits. */
  caps: number;
}
/**
 * The present intersection for the caller's scope, or the standard refusal
 * shape. A non-refusal reply is ALWAYS `{ contacts }` - an empty array means
 * "none of the handles you know are present", never "here is your contact
 * list".
 */
export type ZafuDiscoverContactsResponse = { contacts: ZafuDiscoveredContact[] } | ZafuError;

// -- cosmos fresh-address rotation (burner receive addresses) ---------------

/**
 * Ask the wallet for a fresh cosmos-family receive address on `chainId`.
 *
 * Motivation: on the unshield side of a shielded pool (Penumbra), sending
 * every exit to the same inj1…/osmo1… destination lets an observer group
 * every unshield to that account. The wallet keeps a per-chain HD-index
 * counter and derives a fresh address at each new index, giving the caller
 * (veil, penumbra.fi, any unshield UI) a receiver that has never appeared
 * on-chain before.
 *
 * Scope:
 *   - ONLY for the unshield direction (shielded pool -> transparent chain).
 *     Deposits into the pool keep a stable address for CEX compliance and
 *     should NOT use this method.
 *   - The wallet holds the counter; the caller must NOT try to predict
 *     future addresses. A returned `hdIndex` is informational (for a UI
 *     that wants to display "burner #7").
 *
 * Approvals & rate limiting:
 *   - First call from an origin prompts the user for the wallet's normal
 *     site-permission flow. Subsequent calls succeed silently while the
 *     permission is held.
 *   - Wallets cap total allocations at 100 per origin per chain per 24 h
 *     (`code: 'rate_limited'`) so a hostile site cannot balloon the counter
 *     into the millions.
 *   - `expiresAt` is optional; a wallet MAY hint how long the caller should
 *     wait for a deposit at this address before rotating again (ms since
 *     epoch). Callers SHOULD treat it as advisory - the address remains
 *     spendable indefinitely.
 */
export interface ZafuGetFreshChainAddressRequest {
  type: 'zafu_get_fresh_chain_address';
  /**
   * The chain to derive an address on. This is the wallet's own CosmosChainId
   * (`noble`, `cosmoshub`, `injective`, `osmosis` at time of writing), not a
   * SLIP-173 prefix or a chain-id like `noble-1`.
   */
  chainId: string;
}
export type ZafuGetFreshChainAddressResponse =
  | {
      /** the freshly-derived bech32 address (e.g. `inj1…`) */
      address: string;
      /** the HD index the address was derived at (post-increment, first call = 1). */
      hdIndex: number;
      /**
       * advisory UTC millis after which the caller SHOULD request a new
       * address rather than reuse this one. Omitted when the wallet has no
       * hint; callers MUST NOT assume the address stops working at this time.
       */
      expiresAt?: number;
    }
  | ZafuError;

/**
 * zafu_open_shield - ask the wallet to show its own shield-in screen for a
 * public source chain (e.g. Veil's "deposit from Injective" handing off to
 * the wallet).
 *
 * The dapp learns nothing and controls nothing: no address, key, amount or
 * destination crosses the boundary. The wallet picks the surface (its side
 * panel when open, else a popup) and runs the whole shield flow itself, so the
 * user sees their wallet's UI, not the dapp's. Requires the origin to hold the
 * `connect` capability; the call resolves once the screen is shown.
 */
export interface ZafuOpenShieldRequest {
  type: 'zafu_open_shield';
  /**
   * Source chain to shield from, as the wallet's CosmosChainId
   * (`injective` at time of writing).
   */
  chainId: string;
}
export type ZafuOpenShieldResponse = { opened: true } | ZafuError;

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
  zafu_discover_contacts: {
    request: ZafuDiscoverContactsRequest;
    response: ZafuDiscoverContactsResponse;
  };
  zafu_get_fresh_chain_address: {
    request: ZafuGetFreshChainAddressRequest;
    response: ZafuGetFreshChainAddressResponse;
  };
  zafu_open_shield: { request: ZafuOpenShieldRequest; response: ZafuOpenShieldResponse };
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
  'zafu_discover_contacts',
  'zafu_get_fresh_chain_address',
  'zafu_open_shield',
] as const satisfies readonly ZafuMethod[];

// Compile-time guarantee that ZAFU_V1_METHODS lists EVERY key of ZafuApi (not
// just valid ones). If a method is added to ZafuApi but not to the array, the
// Exclude is a non-never type and this assignment fails to typecheck.
type MissingFromRuntimeList = Exclude<ZafuMethod, (typeof ZAFU_V1_METHODS)[number]>;
const _everyMethodListed: MissingFromRuntimeList extends never ? true : never = true;
void _everyMethodListed;
