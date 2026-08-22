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
  /** open an e2ee channel to a peer */
  channel: (peerPubkey: string) => Promise<ZidChannel>;
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

/** opaque contact reference — app-scoped, unlinkable across apps */
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
 * it — never on load. The extension-side establisher (identity.ts
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
 * session pubkey, a display name, and — for discovery — your contact card key.
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
}
