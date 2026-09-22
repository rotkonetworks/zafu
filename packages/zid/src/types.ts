import type { RelayTransport } from './contact-relay';
import type { DiscoveredContact, DiscoveryPeer } from './presence-service';

/**
 * A peer's advertised ZID keys - structurally the same shape `zidPubkey()` reads
 * from a wallet (`ZidRecipient`), declared here so the identity surface can name
 * it without importing the wallet messaging module.
 *
 * `pq_sig`/`pq_epoch`/`origin` are optional because they only exist when the
 * advertiser has an identity key to authenticate the post-quantum prekey with.
 * A caller that only knows a bare ed25519 pubkey passes a `string` instead.
 */
export interface AdvertisedKeys {
  /** site-scoped ed25519 pubkey (hex). */
  pubkey: string;
  /** site-scoped post-quantum (X-Wing) sealed-box pubkey (hex), when advertised. */
  pq_pubkey?: string;
  /** the suite of pq_pubkey (e.g. 'xwing-v1'). */
  pq_suite?: string;
  /** ed25519 signature (hex) by `pubkey` authenticating pq_pubkey. */
  pq_sig?: string;
  /** rotation epoch pq_pubkey was derived at. */
  pq_epoch?: number;
  /** the origin pq_pubkey was signed for; needed to verify pq_sig. */
  origin?: string;
}

/**
 * A sealed box as BYTES. Field names mirror `encryptFor`'s result exactly; the
 * only difference is the encoding - the wallet wire carries base64/hex strings,
 * a local identity hands back raw bytes. An empty `ephemeral_pubkey` selects the
 * post-quantum path (the ephemeral is inside the X-Wing ciphertext).
 */
export interface SealedBox {
  ciphertext: Uint8Array;
  ephemeral_pubkey: Uint8Array;
  /** whether the post-quantum path was actually used (not merely intended). */
  postQuantum: boolean;
  /** the epoch the recipient's pq key was advertised at (PQ path only). */
  pq_epoch?: number;
}

/** the subset `openSealed` consumes - mirrors `decryptFrom`'s argument. */
export interface OpenableSealed {
  ciphertext: Uint8Array;
  ephemeral_pubkey: Uint8Array;
  pq_epoch?: number;
}

/** options for {@link ZidIdentity.discover}. */
export interface DiscoverOptions {
  /** presence epoch to query; defaults to the current JAM epoch. */
  epoch?: number;
  /** relay transport to use for this call; overrides the one chosen at connect. */
  transport?: RelayTransport;
  /** app scope / bucket namespace; defaults to the identity's origin. */
  appOrigin?: string;
}

/**
 * Which handshake the e2ee channel uses.
 *
 * - `'hybrid'` (default): the post-quantum Noise IK channel. Fails CLOSED
 *   against a peer that cannot do it - there is no downgrade.
 * - `'classical'`: the legacy X25519 + AES-GCM channel. Needed to reach a peer
 *   on `@zafu/zid@0.1.0`, which speaks only the classical handshake.
 * - `'auto'`: try hybrid, fall back to classical if the handshake fails. That is
 *   a downgrade the caller accepts KNOWINGLY - which is why it is not the
 *   default and is never implicit.
 */
export type ChannelMode = 'hybrid' | 'classical' | 'auto';

/** the handshake a channel actually ended up using. */
export type ChannelKind = 'hybrid' | 'classical';

/** connected zafu identity */
export interface ZidIdentity {
  /** hex-encoded ed25519 public key (session key) */
  pubkey: string;
  /** active network ('penumbra' | 'zcash' | 'polkadot' | ...) */
  network: string;
  /** display name (first 8 chars of pubkey, or custom) */
  name: string;
  /** sign arbitrary bytes with session key. returns hex signature */
  sign: (data: Uint8Array) => Promise<string>;
  /** verify a signature. returns true if valid */
  verify: (data: Uint8Array, sig: string, pubkey: string) => Promise<boolean>;
  /**
   * Open an e2ee channel to a peer. Which handshake it uses is the
   * `channel` option on `zid.connect()` (`'hybrid'` by default) - see
   * {@link ChannelMode}.
   */
  channel: (peerPubkey: string) => Promise<ZidChannel>;
  /**
   * This identity's own advertised keys - mirrors `zidPubkey()`. Present on the
   * ephemeral identity, where the keys are derived locally.
   */
  keys?: () => AdvertisedKeys;
  /**
   * Seal `bytes` to a recipient - mirrors `encryptFor`. Post-quantum (X-Wing)
   * whenever the recipient advertises a pq_pubkey, classical otherwise. Present
   * in both modes so the call site does not change with the backend.
   */
  sealFor?: (recipient: AdvertisedKeys | string, bytes: Uint8Array) => Promise<SealedBox>;
  /** Open a box addressed to this identity - mirrors `decryptFrom`. */
  openSealed?: (sealed: OpenableSealed) => Promise<Uint8Array>;
  /**
   * This identity's own contact-card key-agreement key (ephemeral mode). Share
   * it so peers can derive the pairwise root secret for private discovery.
   */
  contactCard?: () => ContactCardKey;
  /**
   * Derive the pairwise root secret for a peer's contact card with THIS
   * identity's key-agreement key (ephemeral mode). The local counterpart of the
   * wallet's injected `deriveRootSecret`. Caller should zeroize the result.
   */
  deriveRootSecret?: (card: ContactCardKey) => Uint8Array;
  /**
   * Establish (once, cached) the pairwise root secret for a stored contact, or
   * `null` when the contact is unknown/legacy (no card). Ephemeral mode.
   */
  establishSecret?: (pubkey: string) => Uint8Array | null;
  /**
   * Find which of `peers` are present this epoch, over the blind relay -
   * ephemeral mode. Same contract as the wallet's `zafu_discover_contacts`.
   */
  discover?: (
    peers: readonly DiscoveryPeer[],
    opts?: DiscoverOptions,
  ) => Promise<DiscoveredContact[]>;
  /** pick contacts from wallet address book (zafu mode only) */
  pickContacts?: (opts?: PickContactsOptions) => Promise<ContactRef[]>;
  /** send invite to a contact handle (zafu mode only) */
  invite?: (handle: string, payload: InvitePayload) => Promise<InviteResult>;
  /** listen for incoming invites (zafu mode only). returns unsubscribe fn */
  onInvite?: (handler: (invite: IncomingInvite) => void) => () => void;
  /** whether connected via zafu extension or browser-generated key */
  mode: 'zafu' | 'ephemeral';
  /** zafu wallet pubkey (if mode === 'zafu') */
  walletPubkey?: string;
  /** delegation signature proving wallet authorized this session */
  delegation?: string;
  /** disconnect and clear session */
  disconnect: () => void;
}

/** encrypted channel between two zid identities */
export interface ZidChannel {
  /** peer's public key */
  peer: string;
  /**
   * The handshake this channel actually used. Set by `openChannel`, so an
   * `'auto'` caller can SEE a downgrade (`kind === 'classical'`) and refuse,
   * warn, or record it instead of being told nothing.
   */
  kind?: ChannelKind;
  /** send encrypted message */
  send: (data: string | Uint8Array) => void;
  /** receive callback */
  on: (event: 'message', handler: (data: Uint8Array) => void) => void;
  /** close channel */
  close: () => void;
}

// ---------------------------------------------------------------------------
// Contact picker (social graph never crosses the trust boundary)
// ---------------------------------------------------------------------------

/** opaque contact reference - app-scoped, unlinkable across apps */
export interface ContactRef {
  /** app-scoped opaque handle (hex, 32 bytes). deterministic per contact+app */
  handle: string;
  /** display name the user chose to share (may differ from internal contact name) */
  displayName: string;
}

/**
 * The public half of a contact's key-agreement key, as it travels on the
 * contact card. Used to establish the pairwise root secret for private,
 * non-interactive contact discovery (see `establishContactSecret`).
 *
 * `suite` is intentionally a WIDE `string`, not a narrow union: an unknown
 * FUTURE suite (e.g. a post-quantum hybrid) must ROUND-TRIP through storage
 * untouched and fail CLOSED only when someone tries to establish a secret with
 * it - never on load. The extension-side establisher (identity.ts
 * `zidContactRootSecret`) owns the narrow `ContactSuite` union and throws on an
 * unrecognized suite. Structurally compatible with identity.ts `ContactCardKey`,
 * but declared locally so this DApp-shipped SDK never imports extension state
 * (the mnemonic never crosses that boundary).
 */
export interface ContactCardKey {
  /** KA suite id, e.g. 'x25519-v1'. Round-tripped verbatim; validated at establish. */
  suite: string;
  /** hex public key. X25519 pubkey for 'x25519-v1'; a KEM encapsulation key for a hybrid. */
  publicKey: string;
}

/**
 * What you hand a peer (or import from the wallet) so they can add you: your
 * session pubkey, a display name, and - for discovery - your contact card key.
 * `card` is optional so legacy exchanges (pre-discovery) still parse.
 */
export interface ContactShare {
  /** session pubkey of the contact */
  pubkey: string;
  /** display name */
  name: string;
  /** contact-card key-agreement key (absent on legacy contacts) */
  card?: ContactCardKey;
}

/** options for pickContacts() */
export interface PickContactsOptions {
  /** shown in picker: "poker.zk.bot wants to invite a friend" */
  purpose?: string;
  /** max contacts user can select (default: 1) */
  max?: number;
}

/** payload for sending an invite to a contact */
export interface InvitePayload {
  /** app-defined type (e.g., "poker-table-invite") */
  type: string;
  /** app-defined data (e.g., { tableId, blinds }) */
  data: Record<string, unknown>;
  /** expiry in seconds (default: 3600) */
  ttl?: number;
}

/** result of sending an invite */
export interface InviteResult {
  /** whether the invite was delivered to the relay */
  sent: boolean;
  /** if recipient is online, whether they acknowledged */
  delivered?: boolean;
}

/** incoming invite from another app user */
export interface IncomingInvite {
  /** which app sent this */
  appOrigin: string;
  /** app-defined type */
  type: string;
  /** app-defined data */
  data: Record<string, unknown>;
  /** display name of the sender */
  fromName: string;
  /** accept the invite */
  accept: () => void;
  /** decline silently */
  decline: () => void;
}

/** options for zid.connect() */
export interface ZidOptions {
  /** app name shown in wallet approval popup */
  appName?: string;
  /** preferred network (default: wallet's active network) */
  network?: string;
  /** request trading mode (auto-sign without popups) */
  tradingMode?: boolean;
  /** trading mode session duration in minutes (default: 60) */
  sessionMinutes?: number;
  /** custom WebSocket URL for e2ee relay (default: same origin /ws/zid) */
  relayUrl?: string;
  /** skip zafu detection, use ephemeral key */
  ephemeral?: boolean;
  /**
   * Which handshake `me.channel()` uses - see {@link ChannelMode}. Default
   * `'hybrid'`.
   *
   * INTEROP: `@zafu/zid@0.1.0` speaks only the classical handshake, and the
   * hybrid protocol name is deliberately distinct so a mixed pair FAILS the
   * handshake rather than downgrading. A default-mode caller therefore cannot
   * open a channel to a 0.1.0 peer: pass `'classical'` to reach one, or `'auto'`
   * to accept an automatic downgrade knowingly. There is no silent fallback.
   */
  channel?: ChannelMode;
  /**
   * Where the ephemeral identity's seed lives. Omitted (default) = IN-MEMORY
   * only for this page: burner-grade custody, gone on reload. `'local'` stores
   * it in `localStorage` so the identity survives reloads - still NOT a wallet
   * (no backup, no recovery, readable by any script on the origin). Ignored in
   * zafu mode.
   */
  persist?: 'local';
  /**
   * Relay transport for contact discovery (`me.discover`). Defaults to an HTTP
   * transport built from `relayEndpoint` when that is given; otherwise discovery
   * is unavailable until a transport is supplied.
   */
  relayTransport?: RelayTransport;
  /** Base URL for the HTTP contact-discovery relay (see `createHttpRelayTransport`). */
  relayEndpoint?: string;
  /** Bearer token for a gated relay endpoint (e.g. a friend's bouncer). */
  relayToken?: string;
}
