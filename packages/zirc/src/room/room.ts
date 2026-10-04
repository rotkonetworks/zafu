/**
 * A community room on a zafu relay's blind store.
 *
 * What this is: N members, one shared room secret, and a windowed append-only
 * board the relay cannot read. It reuses the exact transport a zafu relay
 * already speaks for private contact discovery - `putBucket`/`getBucket` keyed by
 * `(appScope, epoch, shard)`, merge-by-tag, whole-bucket reads - so a room needs
 * no new server behaviour, no new route, and no relay cooperation beyond what
 * `minirelay` already does. A bouncer in front changes nothing: it is HTTP.
 *
 * Layout, per window (one presence epoch = 5 minutes, so the relay's retention
 * sweep and this room's clock agree by construction):
 *
 *   one coordinate  (appScope, epoch, shard) - the shard comes from the channel
 *                   name for a public room and from the room secret for a sealed
 *                   one, which is the default (see `RoomConfig.public`)
 *   one entry per message   tag = HKDF(roomSecret, 'veil-room-tag-v1', epoch, random nonce)
 *   one entry per member    tag = HKDF(roomSecret, 'veil-room-tag-v1', epoch, author)
 *
 * Tags are opaque, so the relay merges them without learning which entry is
 * whose. A message tag is random per write, which is what stops one member from
 * computing a peer's tag and overwriting their message - the relay's merge is an
 * overwrite primitive, and an unpredictable key is the only thing that keeps it
 * from being one between members. A member's presence tag is stable instead, so
 * refreshing presence overwrites their own entry rather than piling up. Entries
 * are found by fetching the whole window and trying to open each one: anything
 * that does not authenticate under the room key (a stranger's write, or noise) is
 * dropped silently.
 *
 * What this guarantees, precisely:
 *
 *   confidentiality  only holders of the room secret read anything. The AES-256-GCM
 *                    key is derived per (appScope, shard, epoch, kind) with
 *                    HKDF-SHA256, so compromising one window's key does not open
 *                    another's and messages and presence never share one.
 *   authenticity     every record - message, action, direct message and
 *                    presence - is signed by its author's ed25519 key. From
 *                    record version 0x04 the signature covers the room (the
 *                    app scope's and the shard's hashes), the window, the
 *                    author's `ts` and sequence number, so a member cannot
 *                    rewrite another's record, re-seal it into another window
 *                    or carry it to another room, and cannot announce someone
 *                    else's presence. A reader refuses any record whose signed
 *                    `ts` falls outside the window it was served in (one window
 *                    of clock skew either side); that check also covers older
 *                    0x02 records, whose `ts` was already signed. The AEAD's
 *                    AAD binds the window too, but every member can recompute
 *                    it, so it is not what stops a member.
 *   tamper-evidence  each author's records form a hash chain (`prev`). Rewriting
 *                    your own history is detectable by anyone who saw the earlier
 *                    link.
 *   fixed-size writes  every message blob is the same length, so the relay cannot
 *                    tell a one-character reply from a paragraph.
 *
 * What it does NOT guarantee, stated plainly:
 *
 *   - No secrecy between members. A direct message is sealed under a key derived
 *     from the room secret and the recipient's pubkey, so any holder of the room
 *     secret can derive that key and read the message. The DM lane hides who is
 *     talking to whom from the relay, and keeps non-members out; it is NOT a
 *     member-to-member secret. See docs/design/zirc-shared-secret-mailbox.md.
 *   - No forward secrecy beyond the window: the room secret is long-lived. A
 *     member who leaks it can read this window and every window its writers
 *     derive from it, and the derivation is a KDF, not a ratchet with compromise
 *     healing. Rotating the room secret (a new room, or a re-invite) is the
 *     remedy, and it is a deliberate act, not automatic.
 *   - No global order. Each author's `ts` is their own clock's claim; the relay
 *     stores a set, not a sequence. The chain orders one author's messages
 *     relative to each other, nothing more.
 *   - No hiding of traffic shape. The relay sees how many entries a window
 *     holds, when they were written, and from which address family. It does not
 *     see authors, lengths, or content.
 *   - No moderation. Everything signed is kept; hiding, ops and votes live a
 *     layer up (see `@zafu/zirc`), where a decision is a signed record rather
 *     than a deletion.
 *   - No hiding of the coordinate from the relay serving it. The relay is
 *     addressed by the shard on every read and write, so it sees which board a
 *     client uses and can refuse to serve it. What a sealed room (the default)
 *     buys is that the shard is derived from the secret, not from a name, so
 *     nobody can *enumerate* boards by guessing channel names - see
 *     `roomShardFromSecret`.
 */

import { concat, lpText, PresenceEntry, presenceEpoch, RelayTransport, u32be } from '@zafu/zid';

// ---------------------------------------------------------------------------
// wire format
// ---------------------------------------------------------------------------

/**
 * room record version, first byte inside the AEAD - the version this writer
 * emits.
 *
 * 0x02 is 0x01 plus a recipient field (empty outside a direct message). Readers
 * accept both: an older record still authenticates because the signature covers
 * the layout it was written in, not the one we prefer now. What is *never* done
 * is writing the old shape, so the format moves forward one way and the records
 * already on a relay stay readable until they age out.
 */
export const ROOM_VERSION = 0x04;

/**
 * Record version for the unsealed lane: 0x02 plus the window the record was
 * written in.
 *
 * A sealed record's window is bound by the AEAD's AAD, so a relay cannot serve
 * last window's ciphertext as this window's. An unsealed record has no AAD, and
 * the author's `ts` is their own clock's claim, not the window - so without this
 * field nothing binds a plain line, or a plain presence record, to a window and
 * a relay could replay one as current. A plain record therefore carries its
 * window inside the signed bytes, and a reader refuses one that does not.
 */
const ROOM_PLAIN_VERSION = 0x03;

/**
 * Record version that signs its context: 0x03's layout (window field
 * included), with the signature taken over
 * `"zirc-record-v4" ‖ sha256(appScope) ‖ shardHash ‖ record`.
 *
 * Before it, a sealed record's window and room were bound only by the AEAD's
 * AAD, which any holder of the room secret can recompute: a member could
 * re-seal another member's signed record into a later window, once the
 * original had aged out of the read horizon, or into another room the same
 * key writes in. Presence carries a signature from this version on too. Both
 * lanes write it; the room context is not sent, each reader supplies its own.
 */
const ROOM_BOUND_VERSION = 0x04;

/** domain tag in front of a 0x04 record's signed bytes */
const RECORD_SIG_DOMAIN = 'zirc-record-v4';

/** a record's `ts` may sit this many windows either side of the one it is in */
const TS_WINDOW_SKEW = 1;

/** versions a reader will open, newest first. */
const ROOM_READ_VERSIONS: readonly number[] = [0x04, 0x03, 0x02, 0x01];

/** the first version that carries a recipient field. */
const RECIPIENT_FIELD_VERSION = 0x02;

/** blob version, first byte of every entry's blob: sealed under a room key. */
const BLOB_VERSION = 0x01;

/**
 * blob version for an entry that is NOT sealed.
 *
 * A visitor with no invite has no room key, and refusing to let them speak is a
 * worse default than letting them speak in the open. Their records ride the same
 * coordinate, marked so every reader knows what they are: no AEAD, so the relay,
 * the operator, and anyone else who can read the relay can read them. The record
 * inside still carries an author signature, so a plaintext line is anchored to a
 * key - it is unprivate, not unauthenticated.
 */
const BLOB_PLAIN = 0x02;

/**
 * Fixed plaintext size. Every message is padded to exactly this, so a window's
 * entries are indistinguishable by size. 1 KiB leaves ~900 bytes of body, which
 * is a long chat message and a short link list; anything longer is refused
 * rather than silently truncated (see {@link encodeRecord}).
 */
export const ROOM_PLAINTEXT_BYTES = 1024;

/**
 * Plaintext size for a group-purse or door room (see
 * `design-groups-on-zirc.md` 1.3): a seal, a share record, or a split PCZT
 * chunk needs more body than chat's 1 KiB. Still one fixed size per room, so a
 * window's entries stay indistinguishable by length within that room.
 */
export const GROUP_ROOM_PLAINTEXT_BYTES = 4096;

/** the 1-hour door room bootstrapping an invite uses the same size as a group room. */
export const DOOR_ROOM_PLAINTEXT_BYTES = GROUP_ROOM_PLAINTEXT_BYTES;

/**
 * The relay `appScope` a group-purse room uses (`design-groups-on-zirc.md`
 * 1.1). Exported so a relay operator's per-scope retention config
 * (`MINIRELAY_SCOPE_RETENTION`, see `apps/minirelay`) and this package agree on
 * the exact string without either side hardcoding the other's constant.
 */
export const ZAFU_GROUP_APP_SCOPE = 'zafu-group-v1';

/** version(1) + nonce(12) + ciphertext(plaintextBytes) + GCM tag(16). */
export const sealedBlobBytes = (plaintextBytes: number): number => 1 + 12 + plaintextBytes + 16;

/**
 * How many entries one window of a room may hold before a reader stops
 * buffering: every member's lines and presence for five minutes. Its own
 * number, not the relay client's default: that one is sized for a discovery
 * bucket (16384 small entries), and a room's entries are kilobytes each, so
 * borrowing it would let one hostile window make a reader buffer hundreds of
 * megabytes (groups design 0.1 sizes a group window at 256).
 */
export const ROOM_WINDOW_ENTRIES = 256;

/**
 * The `createHttpRelayTransport` limits a room of this plaintext size needs.
 *
 * `MAX_RELAY_ENTRY_BASE64` in `@zafu/zid` defaults to 1024 base64 chars, sized
 * for contact discovery's 64-byte presence blobs - far smaller than ANY sealed
 * room record (even the default 1 KiB chat room seals to 1053 bytes, 1404
 * base64 chars, already over that ceiling). A room that does not pass its own
 * limit has every one of its entries silently refused by the transport - the
 * bug this function exists to make impossible to repeat. Every `Room` built
 * against a real relay MUST wire these into {@link RelayTransport}'s
 * constructor options (`createHttpRelayTransport({ ...opts, ...relayLimitsFor(plaintextBytes) })`).
 *
 * The read is bounded by `maxEntries` windows' worth of this room's records,
 * never by the discovery defaults: `maxBodyBytes` is what the transport stops
 * reading at, so it is the most one window can ever make a reader hold.
 */
export const relayLimitsFor = (
  plaintextBytes: number,
  maxEntries: number = ROOM_WINDOW_ENTRIES,
): { maxEntryBase64: number; maxEntries: number; maxBodyBytes: number } => {
  const sealed = sealedBlobBytes(plaintextBytes);
  const rawBase64 = Math.ceil(sealed / 3) * 4;
  // Rounded up to the next KiB: headroom so a reader on an older/newer record
  // version (different fixed-field widths, same plaintext budget) is never
  // pushed just over the line.
  const maxEntryBase64 = Math.ceil(rawBase64 / 1024) * 1024;
  // one entry on the wire: the blob, a 16-byte tag (24 base64 chars) and its
  // JSON punctuation; rounded up to a whole MiB
  const perEntry = maxEntryBase64 + 64;
  const maxBodyBytes = Math.ceil((maxEntries * perEntry) / (1024 * 1024)) * 1024 * 1024;
  return { maxEntryBase64, maxEntries, maxBodyBytes };
};

/** hex ed25519 public key and signature lengths, as the SDK carries them. */
const PUBKEY_HEX = 64;
const SIG_HEX = 128;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const TAG_BYTES = 16;
const SHA256_BYTES = 32;

/** HKDF labels. Distinct per use: tag, message key, presence key, shard. */
const LABEL_TAG = 'veil-room-tag-v1';
const LABEL_MSG_KEY = 'veil-room-msg-v1';
const LABEL_PRESENCE_KEY = 'veil-room-presence-v1';
const LABEL_DM_KEY = 'veil-room-dm-v1';
const LABEL_SHARD = 'veil-room-shard-v1';
const LABEL_KEY_SHARD = 'veil-room-key-shard-v1';

/** kinds of entry that share a window. */
export type RoomKind = 'msg' | 'presence' | 'action' | 'dm';

/** 0x01/0x02 keep the values the first published records used. */
const KIND_BYTE: Record<RoomKind, number> = { msg: 0x01, presence: 0x02, action: 0x03, dm: 0x04 };

/** record kinds that live under the room's message key. */
const PUBLIC_KINDS = ['msg', 'action'] as const;

/** the kinds a message row can carry. */
export type MessageKind = 'msg' | 'action' | 'dm';

/** an invite is a room secret plus where to use it. */
export const INVITE_PREFIX = 'zroom2:';

/**
 * The first invite shape, which had no channel field: read, never written. A
 * `zroom1:` code joins the default channel.
 */
export const LEGACY_INVITE_PREFIX = 'zroom1:';

/**
 * The field that marks a public room in an encoded invite. It is one character,
 * and `b64url` of any non-empty field is at least two, so it can never be
 * confused with an endpoint or a token: the marker is unambiguous exactly where
 * the optional fields are positional.
 */
const PUBLIC_FIELD = 'p';

// ---------------------------------------------------------------------------
// dependency surface: an identity, and a relay
// ---------------------------------------------------------------------------

/**
 * The slice of an identity a room needs. `ZidIdentity` satisfies this
 * structurally, so callers pass the identity itself - guest today, the wallet's
 * site key tomorrow - and nothing here changes.
 */
export interface RoomIdentity {
  /** hex-encoded ed25519 public key. */
  readonly pubkey: string;
  /** display name the member claims. The panel lets them change it. */
  readonly name?: string;
  /** sign bytes, hex signature back. */
  sign(data: Uint8Array): Promise<string>;
  /** verify a signature against a pubkey. */
  verify(data: Uint8Array, sig: string, pubkey: string): Promise<boolean>;
}

export interface RoomConfig {
  /** relay bucket namespace. The relay may restrict which scopes it serves. */
  appScope: string;
  /** which channel inside that scope: `#penumbra` by default. */
  channel?: string;
  /** 32-byte room secret, shared by members (see {@link createRoomSecret}). */
  roomSecret: Uint8Array;
  /** the room's relay transport (`createHttpRelayTransport`, or a bouncer's). */
  relay: RelayTransport;
  /** how many past windows {@link sync} walks. 12 x 5min = the relay's 1h default. */
  historyWindows?: number;
  /**
   * Pin the relay shard instead of deriving it from the secret. Two callers that
   * pin the same shard meet on the same coordinate while keeping their own keys -
   * which is how a test reads another secret's window, and how a relay with
   * pre-provisioned coordinates is addressed.
   */
  shard?: string;
  /**
   * Address the board by the channel NAME instead of by the room secret - a
   * public room, findable by anyone who can guess the name.
   *
   * That is what a visitor holding no invite needs: type `#penumbra`, land on
   * the board, read the unsealed entries. It is also what lets anyone else do
   * the same, which is the price - the relay can hash its guess list and see
   * that this room exists, censor it by name, and watch when it is active, and
   * every room that picks the same name shares one board. Only opt in when
   * being findable is the point.
   *
   * Omitted (the default) means sealed: the coordinate is derived from
   * `roomSecret`, so it cannot be enumerated by name or attributed to a
   * community. The trade is real and worth stating: with no name coordinate
   * there is nothing for a keyless visitor to find, so a sealed room has no
   * public lane - and the channel name is a local label, not an address.
   *
   * What this decides is the *coordinate*, not the secrecy of the entries: a
   * public room's sealed records stay sealed, and a sealed room's unsealed
   * records stay readable by whoever holds the board.
   */
  public?: boolean;
  /**
   * A shard per window instead of one for the room's life (design-social
   * 2.5): a pair room passes `HKDF(pairSecret, "shard" || u64be(epoch))` so
   * the relay cannot line up one pair's windows across months by shard.
   * Wins over `shard` and `public`. Must return 16 lowercase hex characters,
   * the width {@link roomShardFromSecret} uses.
   */
  shardFor?: (epoch: number) => Promise<string>;
  /**
   * Fixed plaintext size this room's entries pad to - {@link ROOM_PLAINTEXT_BYTES}
   * (chat) by default, {@link GROUP_ROOM_PLAINTEXT_BYTES} for a group or door
   * room. Every entry in one room is still one size (so the relay cannot tell
   * lengths apart within it), but different rooms may choose different sizes.
   * Pass the matching {@link relayLimitsFor} output to whatever built this
   * room's `relay` transport, or its own entries will be the ones silently
   * refused.
   */
  plaintextBytes?: number;
  /** injectable clock, seconds. Defaults to `Date.now()`. Tests pass one. */
  now?: () => number;
  /**
   * This author's chain head as a previous session left it: `{ seq, hash }` from
   * {@link Room.chainHead}. Persist it (a tab's storage, a device) and pass it
   * back so a fresh {@link Room} continues the chain instead of restarting at
   * seq 0 and re-signing a `(seq, prev)` pair this author already used.
   */
  head?: { seq: number; hash: string };
}

/** a message as it arrives from the room, after verification. */
export interface RoomMessage {
  /** hex sha256 of the signed record - the chain link and the dedupe key. */
  hash: string;
  author: string;
  /** display name the author claims for themselves. Signed, not authoritative. */
  name: string;
  seq: number;
  /** hex hash of this author's previous record in the room ('' when unknown). */
  prev: string;
  /** the author's clock, seconds. An ordering hint across authors. */
  ts: number;
  body: string;
  /** the window the record was published in. */
  epoch: number;
  /** what the record is: a message, an action (/me), or a direct message. */
  kind: MessageKind;
  /**
   * True when this arrived unsealed: no room key was involved, so the relay read
   * it too. Anyone in the relay's reach can read it, and the panel says so.
   */
  plain?: boolean;
  /**
   * A direct message's recipient, inside the seal - so the relay never learns who
   * talks to whom, and the sender's own client can still render `-> nick` after a
   * reload.
   */
  to?: string;
}

/** a member seen in the window. */
export interface RoomPresence {
  author: string;
  name: string;
  epoch: number;
  /** announced unsealed, so the relay saw it too. */
  plain?: boolean;
}

/** what {@link Room.sync} found, and what it refused. */
/** why a record was not taken at face value. */
export type DropKind = 'invalid' | 'unsupported' | 'unreachable' | 'oversize';

export interface RoomSync {
  messages: RoomMessage[];
  present: RoomPresence[];
  /**
   * Records that arrived and could not be taken at face value. `invalid` means
   * it authenticated as ours and then failed verification - a real refusal.
   * `unsupported` means it is in a wire version this reader does not know, which
   * is news about versions, not about anybody's honesty.
   */
  dropped: { hash: string; reason: string; kind: DropKind }[];
  /**
   * Entries in these windows that this reader could not open: sealed records when
   * the reader has no room key. It is the honest count of what a visitor is
   * missing - and the reason a visitor has to be told what sealing buys.
   */
  sealed: number;
}

// ---------------------------------------------------------------------------
// bytes, hex, base64url
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

const toHex = (b: Uint8Array): string =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

const fromHex = (s: string): Uint8Array => {
  if (s.length % 2 !== 0) {
    throw new Error('room: odd-length hex');
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

/** copy into a fresh ArrayBuffer-backed view - WebCrypto wants BufferSource. */
const ab = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(u.length));
  out.set(u);
  return out;
};

// ---------------------------------------------------------------------------
// crypto
// ---------------------------------------------------------------------------

const sha256 = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', ab(data)));

/** HKDF-SHA256, raw bytes out. `salt` is the room secret unless overridden. */
export const hkdfBytes = async (
  secret: Uint8Array,
  label: string,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', ab(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ab(enc.encode(label)), info: ab(info) },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
};

/**
 * The window key: HKDF(roomSecret, label(kind), appScope ‖ shardHash ‖ epoch).
 *
 * The label lives in the HKDF **salt** and the room/window in the info, which is
 * what keeps messages and presence on separate keys, and every window on its
 * own - the same construction `zid`'s presence layer uses, with a distinct
 * label so a room secret can never derive a presence-layer key.
 */
const windowKey = async (
  secret: Uint8Array,
  label: string,
  appScope: string,
  shardHash: Uint8Array,
  epoch: number,
  extra?: Uint8Array,
): Promise<CryptoKey> => {
  // `sha256` is async, so every field is resolved BEFORE the parts array is
  // built: a promise in that array has no `length`, which is how a silent
  // zero-length concat happens.
  const parts = [await sha256(enc.encode(appScope)), shardHash, u32be(epoch)];
  // `extra` binds a key to one more thing - a direct message's recipient, so
  // the whole room can seal to a member and that member's client can open it.
  // It is NOT a secret from other members: they hold the same room secret.
  // Absent (the default) it contributes no bytes at all, which keeps every other
  // key exactly as it was.
  if (extra) {
    parts.push(extra);
  }
  const raw = await hkdfBytes(secret, label, concat(parts), KEY_BYTES);
  return crypto.subtle.importKey('raw', ab(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
};

/** the channel a room defaults to when nobody named one. */
export const DEFAULT_CHANNEL = '#penumbra';

/**
 * The shard a **public** channel lives on, inside a relay scope - derived from
 * the channel's NAME.
 *
 * The relay addresses every board by `(appScope, epoch, shard)`, and this is the
 * public shard: a function of a string anyone can guess. That is the whole point
 * of it - a visitor holding no key types `#penumbra` and lands on the board, and
 * the relay needs no per-channel configuration to serve as many channels as a
 * scope wants (`#penumbra`, `#trading`, `#offtopic`), each its own coordinate.
 *
 * The price is exact and worth stating: anyone who can guess a name can compute
 * the coordinate, so the relay can hash its guess list and see which channels
 * exist, censor by name, and watch a community's traffic. Every room that picks
 * the same name *shares* the board, too.
 *
 * So this is only for a room that wants to be findable by name - see
 * {@link RoomConfig.public}. A sealed room addresses by
 * {@link roomShardFromSecret} instead.
 */
export const roomShard = async (appScope: string, channel: string): Promise<string> =>
  toHex(
    await hkdfBytes(
      new Uint8Array(KEY_BYTES),
      LABEL_SHARD,
      concat([await sha256(enc.encode(appScope)), await sha256(enc.encode(channel))]),
      8,
    ),
  );

/**
 * The shard a **sealed** room lives on - derived from the room secret, never
 * from the channel name.
 *
 * A secret is not guessable, so nobody can enumerate the board: the relay has no
 * name to hash, and a community's existence, size and rhythm are not a lookup
 * away (`#penumbra` keeps working as a label without being an address). Two
 * rooms that happen to share a name are two separate boards here, not one shared
 * one.
 *
 * The limit, stated honestly: this hides the coordinate from *enumeration*, not
 * from *observation*. The relay serving the request sees the shard it is asked
 * for either way, on every read and write. What changes is that the coordinate
 * is not a function of a guessable string - so it cannot be probed for, matched
 * against a name list, or censored by name.
 */
export const roomShardFromSecret = async (appScope: string, secret: Uint8Array): Promise<string> =>
  toHex(await hkdfBytes(secret, LABEL_KEY_SHARD, concat([await sha256(enc.encode(appScope))]), 8));

/**
 * The entry tag for one message: opaque, unique per write, derived from a fresh
 * random nonce rather than from (author, seq).
 *
 * The relay merges by tag, so a *predictable* tag is an overwrite primitive: any
 * member holding the room secret could compute a peer's tag and replace - or
 * blank - their message. With a random tag the worst a member can do is add
 * entries, and adding entries cannot remove yours. Duplicates (a retry, or the
 * same message published from two windows) are collapsed on read by content
 * hash instead.
 */
const messageTag = async (
  secret: Uint8Array,
  appScope: string,
  epoch: number,
): Promise<Uint8Array> =>
  hkdfBytes(
    secret,
    LABEL_TAG,
    concat([
      await sha256(enc.encode(appScope)),
      u32be(epoch),
      crypto.getRandomValues(new Uint8Array(16)),
    ]),
    TAG_BYTES,
  );

/**
 * The tag for an unsealed entry: no secret is involved, because everyone who can
 * read the relay can read these. Random per message so no one can overwrite
 * anyone; stable per (member, window) for presence, so a refresh replaces it.
 */
export const plainTag = async (
  appScope: string,
  epoch: number,
  author: string,
  stable = false,
): Promise<Uint8Array> =>
  hkdfBytes(
    // the salt is a label, not a key: HKDF needs *something*, and the point here
    // is only domain separation from the sealed lanes.
    new Uint8Array(KEY_BYTES),
    'veil-room-plain-tag-v1',
    concat([
      await sha256(enc.encode(appScope)),
      u32be(epoch),
      fromHex(author),
      stable ? Uint8Array.of(0x01) : crypto.getRandomValues(new Uint8Array(16)),
    ]),
    TAG_BYTES,
  );

/** the entry tag for a member's presence in a window - stable, so it overwrites. */
const presenceTag = async (
  secret: Uint8Array,
  appScope: string,
  epoch: number,
  author: string,
): Promise<Uint8Array> =>
  hkdfBytes(
    secret,
    LABEL_TAG,
    concat([
      await sha256(enc.encode(appScope)),
      u32be(epoch),
      fromHex(author),
      Uint8Array.of(0xff),
    ]),
    TAG_BYTES,
  );

/** AAD: version ‖ sha256(appScope) ‖ shardHash ‖ epoch ‖ kind. Binds the window. */
const aad = (
  appScopeHash: Uint8Array,
  shardHash: Uint8Array,
  epoch: number,
  kind: RoomKind,
): Uint8Array =>
  concat([
    Uint8Array.of(BLOB_VERSION),
    appScopeHash,
    shardHash,
    u32be(epoch),
    Uint8Array.of(KIND_BYTE[kind]),
  ]);

/** blob = version(1) ‖ nonce(12) ‖ ct ‖ tag(16). */
const seal = async (
  key: CryptoKey,
  aadBytes: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aadBytes) },
      key,
      ab(plaintext),
    ),
  );
  return concat([Uint8Array.of(BLOB_VERSION), nonce, ct]);
};

/** the wire form of an unsealed record: one version byte, then the plaintext. */
const plainBlob = (plaintext: Uint8Array): Uint8Array =>
  concat([Uint8Array.of(BLOB_PLAIN), plaintext]);

/** returns null on ANY failure - wrong key, wrong window, tampered bytes. */
const open = async (
  key: CryptoKey,
  aadBytes: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array | null> => {
  if (blob.length <= 1 + NONCE_BYTES + GCM_TAG_BYTES || blob[0] !== BLOB_VERSION) {
    return null;
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ct = blob.subarray(1 + NONCE_BYTES);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ab(nonce), additionalData: ab(aadBytes) },
        key,
        ab(ct),
      ),
    );
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** the signed payload: version ‖ kind ‖ [epoch] ‖ ts ‖ seq ‖ prev ‖ author ‖ name ‖ body. */
const recordBytes = (
  r: {
    kind: RoomKind;
    ts: number;
    seq: number;
    prev: string;
    author: string;
    to: string;
    name: string;
    body: string;
  },
  version: number = ROOM_VERSION,
  epoch = 0,
): Uint8Array =>
  concat([
    Uint8Array.of(version, KIND_BYTE[r.kind]),
    // the unsealed lane has no AAD, so its window is a signed field instead -
    // the whole reason a plain record cannot be replayed into another window.
    ...(version >= ROOM_PLAIN_VERSION ? [u32be(epoch)] : []),
    u32be(r.ts),
    u32be(r.seq),
    r.prev ? fromHex(r.prev) : new Uint8Array(SHA256_BYTES),
    fromHex(r.author),
    // 0x01 had no recipient field. A reader re-encodes with the record's OWN
    // version to check its signature, which is the whole reason this is a
    // parameter rather than a constant.
    ...(version >= RECIPIENT_FIELD_VERSION
      ? [r.to ? fromHex(r.to) : new Uint8Array(PUBKEY_HEX / 2)]
      : []),
    lpText(r.name),
    lpText(r.body),
  ]);

/**
 * What an author signs: the record itself, and from 0x04 on the room and the
 * window it was written for. The context is not on the wire; a reader signs
 * over its own coordinates, so a record carried anywhere else fails.
 */
const signedMessage = (
  record: Uint8Array,
  version: number,
  ctx: { appScopeHash: Uint8Array; shardHash: Uint8Array },
): Uint8Array =>
  version >= ROOM_BOUND_VERSION
    ? concat([lpText(RECORD_SIG_DOMAIN), ctx.appScopeHash, ctx.shardHash, record])
    : record;

/**
 * Why a record's signed `ts` cannot be in the window it was served in, or
 * null. A member re-sealing someone's record into a later window can change
 * the window, never the signed `ts`.
 */
const tsWindowError = (ts: number, epoch: number): string | null =>
  Math.abs(presenceEpoch(ts) - epoch) > TS_WINDOW_SKEW ? 'record time outside its window' : null;

/** max body bytes that still fit one record. Callers get a clear error, not a cut. */
export const maxBodyBytes = (
  name: string,
  to = '',
  version: number = ROOM_VERSION,
  plaintextBytes: number = ROOM_PLAINTEXT_BYTES,
): number =>
  plaintextBytes -
  (recordBytes(
    {
      kind: 'msg',
      ts: 0,
      seq: 0,
      prev: '',
      author: '0'.repeat(PUBKEY_HEX),
      to,
      name,
      body: '',
    },
    version,
  ).length +
    SIG_HEX / 2);

/** the room, as seen by one member. */
export class Room {
  private readonly secret: Uint8Array;
  private readonly appScope: string;
  private readonly appScopeHash: Uint8Array;
  private readonly shardHash: Uint8Array;
  private readonly channel: string;
  private readonly historyWindows: number;
  private readonly plaintextBytes: number;
  private readonly now: () => number;
  private readonly relay: RelayTransport;
  private readonly shardPin: string | undefined;
  private readonly shardFor: ((epoch: number) => Promise<string>) | undefined;
  /** a public room addresses by channel name; a sealed one by the room secret. */
  private readonly isPublic: boolean;

  /** epoch -> (shard) resolved once; the relay coordinate never changes. */
  private shard: string | null = null;

  /**
   * This author's chain head. Every message carries its own `seq` and the hash
   * of the one before it, and the tag is keyed by `seq` - so two messages with
   * the same seq are the same entry as far as the relay is concerned, and the
   * second would overwrite the first. The counter therefore lives here, never in
   * a caller's default, and {@link sync} adopts whatever the room already holds
   * so a reload continues the chain instead of colliding with it. A caller that
   * persists the head and hands it back via {@link RoomConfig.head} gets that
   * continuation across sessions too, and a relay reply below it is refused.
   */
  private seq = 0;
  private head = '';

  constructor(
    private readonly identity: RoomIdentity,
    config: RoomConfig,
  ) {
    if (config.roomSecret.length !== KEY_BYTES) {
      throw new Error(
        `room: room secret must be ${KEY_BYTES} bytes, got ${config.roomSecret.length}`,
      );
    }
    this.secret = config.roomSecret;
    this.appScope = config.appScope;
    this.channel = config.channel ?? DEFAULT_CHANNEL;
    this.appScopeHash = new Uint8Array(SHA256_BYTES);
    this.shardHash = new Uint8Array(SHA256_BYTES);
    this.historyWindows = config.historyWindows ?? 12;
    this.plaintextBytes = config.plaintextBytes ?? ROOM_PLAINTEXT_BYTES;
    if (this.plaintextBytes < 256) {
      throw new Error(`room: plaintextBytes must be at least 256, got ${this.plaintextBytes}`);
    }
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.relay = config.relay;
    this.shardPin = config.shard;
    this.shardFor = config.shardFor;
    this.isPublic = config.public ?? false;
    this.seq = config.head?.seq ?? 0;
    this.head = config.head?.hash ?? '';
  }

  /** resolve derived coordinates once, then reuse; a per-window shard per window. */
  private async coords(epoch: number): Promise<{
    shard: string;
    shardHash: Uint8Array;
    appScopeHash: Uint8Array;
  }> {
    if (this.shardFor) {
      const shard = await this.shardFor(epoch);
      if (!/^[0-9a-f]{16}$/.test(shard)) {
        throw new Error('room: shardFor must return 16 lowercase hex characters');
      }
      const shardHash = new Uint8Array(SHA256_BYTES);
      shardHash.set(fromHex(shard));
      if (!this.shard) {
        this.shard = shard;
        this.appScopeHash.set(await sha256(enc.encode(this.appScope)));
      }
      return { shard, shardHash, appScopeHash: this.appScopeHash };
    }
    if (!this.shard) {
      // A pinned shard wins - tests, and a relay with pre-provisioned
      // coordinates. Otherwise the mode decides: a public room is addressed by
      // name so a keyless visitor can find it, a sealed one by the secret so
      // nothing about it can be enumerated.
      this.shard =
        this.shardPin ??
        (this.isPublic
          ? await roomShard(this.appScope, this.channel)
          : await roomShardFromSecret(this.appScope, this.secret));
      this.shardHash.set(fromHex(this.shard));
      this.appScopeHash.set(await sha256(enc.encode(this.appScope)));
    }
    return { shard: this.shard, shardHash: this.shardHash, appScopeHash: this.appScopeHash };
  }

  /** the window the clock is in right now. */
  currentEpoch(): number {
    return presenceEpoch(this.now());
  }

  /** the channel this room is on, as it is written: `#penumbra`. */
  channelName(): string {
    return this.channel;
  }

  /**
   * Seal + publish one public message. Returns it as the room will read it.
   *
   * `plain: true` publishes it unsealed instead - readable by the relay, by the
   * operator, and by every other reader of the coordinate. That is the guest's
   * lane, and it is a choice the caller makes explicitly, never a silent fallback
   * when sealing fails.
   */
  async send(
    body: string,
    opts: {
      kind?: 'msg' | 'action';
      name?: string;
      seq?: number;
      prev?: string;
      epoch?: number;
      plain?: boolean;
    } = {},
  ): Promise<RoomMessage> {
    return this.publish(opts.kind ?? 'msg', body, opts);
  }

  /**
   * A direct message: sealed under a key derived from the room secret AND the
   * recipient's pubkey, so every member can seal to any other and the named
   * recipient's client opens it by trying that key on entries the room key did
   * not open. The sender never appears in the clear, so the relay learns nothing
   * about who is talking to whom beyond "an entry appeared".
   *
   * The room's shared secret is the limit, stated exactly: the DM key is
   * HKDF(roomSecret, ..., recipientPubkey), so *any* holder of the room secret
   * can derive it. This is confidentiality against non-members and the relay, NOT
   * against fellow members - a member who keeps the secret (or kept a copy after
   * leaving) can read every DM in the room. It is also why any member can seal
   * *to* you, so a member can spam your slot; they cannot replace what you sent
   * because tags are random per write. A genuine member-to-member secret needs a
   * pairwise key exchange (see docs/design/zirc-shared-secret-mailbox.md).
   */
  async sendDirect(
    to: string,
    body: string,
    opts: { name?: string; epoch?: number } = {},
  ): Promise<RoomMessage> {
    if (to === this.identity.pubkey) {
      throw new Error('room: a direct message needs a recipient');
    }
    if (to.length !== PUBKEY_HEX) {
      throw new Error('room: recipient must be a 64-char public key');
    }
    return this.publish('dm', body, { ...opts, to });
  }

  private async publish(
    kind: 'msg' | 'action' | 'dm',
    body: string,
    opts: {
      to?: string;
      name?: string;
      seq?: number;
      prev?: string;
      epoch?: number;
      plain?: boolean;
    } = {},
  ): Promise<RoomMessage> {
    if (opts.plain && kind === 'dm') {
      throw new Error('room: a direct message cannot be sent in the clear');
    }
    const epoch = opts.epoch ?? this.currentEpoch();
    const { shardHash, appScopeHash } = await this.coords(epoch);
    const name = opts.name ?? this.identity.name ?? this.identity.pubkey.slice(0, 8);
    const to = opts.to ?? '';
    const bytes = enc.encode(body);
    const room = maxBodyBytes(name, to, ROOM_VERSION, this.plaintextBytes);
    if (bytes.length > room) {
      throw new Error(`room: message is ${bytes.length} bytes, the limit is ${room}`);
    }

    const seq = opts.seq ?? this.seq + 1;
    const prev = opts.prev ?? (seq === 1 ? '' : this.head);
    const ts = this.now();
    const rec = { kind, ts, seq, prev, author: this.identity.pubkey, to, name, body };
    const record = recordBytes(rec, ROOM_VERSION, epoch);
    const signed = signedMessage(record, ROOM_VERSION, { appScopeHash, shardHash });
    const sig = await this.identity.sign(signed);
    if (sig.length !== SIG_HEX) {
      throw new Error('room: identity returned a malformed signature');
    }

    const hash = toHex(await sha256(concat([signed, fromHex(sig)])));
    const sigBytes = fromHex(sig);
    const plaintext = new Uint8Array(this.plaintextBytes);
    plaintext.set(concat([record, sigBytes]));
    // the remaining bytes are the pad; zeroes are inside the AEAD, so they leak
    // nothing an attacker can use, and the size is constant either way.

    // plaintext: no key, no AAD - the record goes out as it is, and the reader
    // knows it by the blob's version byte.
    const blob = opts.plain
      ? plainBlob(plaintext)
      : await seal(
          kind === 'dm'
            ? await windowKey(
                this.secret,
                LABEL_DM_KEY,
                this.appScope,
                shardHash,
                epoch,
                fromHex(to),
              )
            : await windowKey(this.secret, LABEL_MSG_KEY, this.appScope, shardHash, epoch),
          aad(appScopeHash, shardHash, epoch, kind),
          plaintext,
        );
    const tag = opts.plain
      ? await plainTag(this.appScope, epoch, this.identity.pubkey)
      : await messageTag(this.secret, this.appScope, epoch);

    // One entry, one write. The relay merges by tag, so this lands beside every
    // other publisher's entry instead of replacing the coordinate - which is why
    // there is no read before this write.
    await this.relay.putBucket({
      appScope: this.appScope,
      epoch,
      shard: await this.shardOrThrow(epoch),
      entries: [{ tag, blob }],
    });

    // Advance the head only after the write lands, so a failed publish leaves the
    // next attempt at the same seq rather than a hole.
    this.seq = seq;
    this.head = hash;

    return {
      hash,
      author: this.identity.pubkey,
      name,
      seq,
      prev,
      ts,
      body,
      epoch,
      kind,
      ...(opts.plain ? { plain: true } : {}),
      ...(to ? { to } : {}),
    };
  }

  /**
   * Publish (or refresh) this member's presence in the current window. `plain`
   * announces in the clear, which is what a visitor with no room key can do - and
   * all they need, since presence is "I am here", not a secret.
   */
  async announce(name?: string, opts: { plain?: boolean; epoch?: number } = {}): Promise<void> {
    const win = opts.epoch ?? this.currentEpoch();
    const { shardHash, appScopeHash } = await this.coords(win);
    const display = name ?? this.identity.name ?? this.identity.pubkey.slice(0, 8);
    const rec = {
      kind: 'presence' as const,
      ts: this.now(),
      seq: 0,
      prev: '',
      author: this.identity.pubkey,
      to: '',
      name: display,
      body: '',
    };
    // signed like any record, so a member cannot announce someone else
    const record = recordBytes(rec, ROOM_VERSION, win);
    const sig = await this.identity.sign(
      signedMessage(record, ROOM_VERSION, { appScopeHash, shardHash }),
    );
    if (sig.length !== SIG_HEX) {
      throw new Error('room: identity returned a malformed signature');
    }
    const plaintext = new Uint8Array(this.plaintextBytes);
    plaintext.set(concat([record, fromHex(sig)]));
    const blob = opts.plain
      ? plainBlob(plaintext)
      : await seal(
          await windowKey(this.secret, LABEL_PRESENCE_KEY, this.appScope, shardHash, win),
          aad(appScopeHash, shardHash, win, 'presence'),
          plaintext,
        );
    const tag = opts.plain
      ? await plainTag(this.appScope, win, this.identity.pubkey, true)
      : await presenceTag(this.secret, this.appScope, win, this.identity.pubkey);
    // The tag is stable per (member, window), so a re-announce overwrites its own
    // entry - one member, one presence record, however often the panel refreshes.
    await this.relay.putBucket({
      appScope: this.appScope,
      epoch: win,
      shard: await this.shardOrThrow(win),
      entries: [{ tag, blob }],
    });
  }

  /**
   * Read the last `historyWindows` windows, oldest first, and verify everything.
   * Records that do not authenticate are dropped - not shown as "unknown", not
   * trusted - and reported so a caller can say how many were refused.
   *
   * This never runs by itself: constructing or restoring a `Room` makes no
   * network request, and neither does any other method here - only a caller
   * invoking `sync`/`syncSince`/`send`/`announce` does. A member who has not
   * opened this room, or who has not opted into its relay, generates no
   * traffic for it. Wire the alarm, the poll loop and the egress opt-in one
   * layer up, scoped to the room the user is actually looking at.
   */
  async sync(epochs = this.historyWindows): Promise<RoomSync> {
    const current = this.currentEpoch();
    const windows = Array.from({ length: epochs }, (_, i) => current - (epochs - 1 - i)).filter(
      e => e >= 0,
    );
    return this.syncWindows(windows);
  }

  /**
   * Catch up from `sinceEpoch` (inclusive) to now, capped at `maxWindows` so a
   * member who has been away a very long time still pays a bounded number of
   * requests rather than one per window since the beginning of time.
   *
   * This is what a returning member calls instead of `sync(historyWindows)`:
   * `historyWindows` only covers the relay's own retention (12 x 5 min = the
   * discovery default's 1 h), so a room kept 25 h by a per-scope retention
   * entry (see minirelay's `MINIRELAY_SCOPE_RETENTION`) needs every window the
   * relay still holds, not just the last 12. Persist the returned sync's
   * latest window (the caller's own `lastSyncedEpoch`, not tracked here - a
   * room has no durable storage of its own) and pass it back next time so a
   * second catch-up does not re-read windows already read.
   *
   * Like {@link sync}, this makes no network request on its own: it runs only
   * when a caller invokes it, which should be "the user opened this room" or
   * "this room's alarm fired because the user opted in", never on extension
   * start, unlock, or popup open.
   */
  async syncSince(sinceEpoch: number, maxWindows = 288): Promise<RoomSync> {
    const current = this.currentEpoch();
    const floor = Math.max(sinceEpoch, current - maxWindows + 1, 0);
    const windows = Array.from({ length: current - floor + 1 }, (_, i) => floor + i);
    return this.syncWindows(windows);
  }

  private async syncWindows(windows: number[]): Promise<RoomSync> {
    const keysFor = new Map<number, { msg: CryptoKey; presence: CryptoKey; dm: CryptoKey }>();
    const dropped: { hash: string; reason: string; kind: DropKind }[] = [];
    const messages: RoomMessage[] = [];
    const present: RoomPresence[] = [];
    let sealed = 0;
    const seen = new Set<string>();

    for (const epoch of windows) {
      const { shard, shardHash, appScopeHash } = await this.coords(epoch);
      let entries: PresenceEntry[];
      try {
        entries = await this.relay.getBucket({
          appScope: this.appScope,
          epoch,
          shard,
        });
      } catch (e) {
        dropped.push({
          hash: `window:${epoch}`,
          reason: e instanceof Error ? e.message : 'fetch failed',
          kind: 'unreachable',
        });
        continue;
      }
      // a relay transport that enforces its own base64 ceiling (see
      // `relayLimitsFor`) reports what it refused instead of swallowing it; a
      // mis-sized transport (this room's `plaintextBytes` outgrew the limit it
      // was built with) shows up here as a hard count, never a silent gap.
      const oversize = (entries as unknown as Partial<{ droppedOversize: { index: number }[] }>)
        .droppedOversize;
      if (oversize && oversize.length > 0) {
        dropped.push({
          hash: `window:${epoch}`,
          reason: `relay transport refused ${oversize.length} oversized entr${oversize.length === 1 ? 'y' : 'ies'} - its maxEntryBase64 is smaller than this room needs`,
          kind: 'oversize',
        });
      }
      let keys = keysFor.get(epoch);
      if (!keys) {
        keys = {
          msg: await windowKey(this.secret, LABEL_MSG_KEY, this.appScope, shardHash, epoch),
          presence: await windowKey(
            this.secret,
            LABEL_PRESENCE_KEY,
            this.appScope,
            shardHash,
            epoch,
          ),
          // the direct-message key is derived for THIS member as recipient. Any
          // room member can compute it too - they hold the same room secret - so
          // it is private against non-members, not against fellow members.
          dm: await windowKey(
            this.secret,
            LABEL_DM_KEY,
            this.appScope,
            shardHash,
            epoch,
            fromHex(this.identity.pubkey),
          ),
        };
        keysFor.set(epoch, keys);
      }

      for (const entry of entries) {
        // An entry is either unsealed - which anyone can read, and anyone can
        // tell is unsealed - or it is one of four sealed kinds a reader tries in
        // turn: the room's two public kinds, presence, then a direct message
        // addressed to this member.
        let opened: {
          kind: MessageKind | 'presence';
          plain: Uint8Array;
          plaintext: boolean;
        } | null = null;

        if (entry.blob[0] === BLOB_PLAIN) {
          const body = entry.blob.subarray(1);
          const kindByte = body[1];
          const kind: MessageKind | 'presence' =
            kindByte === KIND_BYTE.presence
              ? 'presence'
              : kindByte === KIND_BYTE.action
                ? 'action'
                : kindByte === KIND_BYTE.msg
                  ? 'msg'
                  : 'dm'; // refused below: a direct message in the clear is nobody's
          opened = { kind, plain: body, plaintext: true };
        } else {
          for (const kind of PUBLIC_KINDS) {
            const plain = await open(
              keys.msg,
              aad(appScopeHash, shardHash, epoch, kind),
              entry.blob,
            );
            if (plain) {
              opened = { kind, plain, plaintext: false };
              break;
            }
          }
          if (!opened) {
            const plain = await open(
              keys.presence,
              aad(appScopeHash, shardHash, epoch, 'presence'),
              entry.blob,
            );
            if (plain) {
              opened = { kind: 'presence', plain, plaintext: false };
            }
          }
          if (!opened) {
            const plain = await open(
              keys.dm,
              aad(appScopeHash, shardHash, epoch, 'dm'),
              entry.blob,
            );
            if (plain) {
              opened = { kind: 'dm', plain, plaintext: false };
            }
          }
        }

        if (!opened) {
          // sealed, and not to this reader: a member's message to the room when we
          // hold no key, or a stranger's noise. Either way it is the count a
          // visitor needs to see.
          sealed += 1;
          continue;
        }

        if (opened.plaintext && opened.kind === 'dm') {
          dropped.push({
            hash: toHex(entry.tag),
            reason: 'direct message in the clear',
            kind: 'invalid',
          });
          continue;
        }

        if (opened.kind === 'presence') {
          const fan = await this.verifyPresence(opened.plain, epoch, {
            appScopeHash,
            shardHash,
          });
          if (typeof fan === 'string') {
            dropped.push({ hash: toHex(entry.tag), reason: fan, kind: dropKindFor(fan) });
            continue;
          }
          if (opened.plaintext) {
            const stale = plainWindowError(fan, epoch);
            if (stale) {
              dropped.push({ hash: toHex(entry.tag), reason: stale, kind: 'invalid' });
              continue;
            }
            // the window is also enforced by the tag: a plain presence tag is
            // HKDF(appScope, epoch, author, stable), which a reader can
            // recompute. A record replayed from another window - even with its
            // epoch field rewritten - cannot carry the expected tag.
            const expected = await plainTag(this.appScope, epoch, fan.author, true);
            if (toHex(expected) !== toHex(entry.tag)) {
              dropped.push({
                hash: toHex(entry.tag),
                reason: 'plain presence tag mismatch',
                kind: 'invalid',
              });
              continue;
            }
          }
          present.push({
            author: fan.author,
            name: fan.name,
            epoch,
            ...(opened.plaintext ? { plain: true } : {}),
          });
          continue;
        }

        const parsed = await this.parse(
          opened.plain,
          epoch,
          opened.kind,
          { appScopeHash, shardHash },
          opened.plaintext,
        );
        if (typeof parsed === 'string') {
          dropped.push({ hash: toHex(entry.tag), reason: parsed, kind: dropKindFor(parsed) });
          continue;
        }
        if (seen.has(parsed.hash)) {
          continue;
        }
        seen.add(parsed.hash);
        messages.push(parsed);
      }
    }

    messages.sort((a, b) => a.epoch - b.epoch || a.ts - b.ts || (a.author < b.author ? -1 : 1));
    verifyChains(messages, dropped);
    this.adoptChainHead(messages, dropped);
    return { messages, present, dropped, sealed };
  }

  /**
   * Continue this author's chain from what the room holds: the highest seq we
   * sent, and its hash as the next `prev`. Called on every sync so a reload, a
   * second tab, or another device picks up where the previous one stopped.
   *
   * The relay decides which of our records to return, so "the highest seq in the
   * reply" is not authoritative. We never adopt a head below the one we already
   * hold - a persisted {@link RoomConfig.head}, or what this session has sent.
   * Adopting a lower one would make the author re-sign a `(seq, prev)` pair they
   * already used: silent self-equivocation. A reply that does not link to our
   * known head - it stops short of it, rewrites that seq, or jumps over seqs
   * without the record that continues the head - is reported in `dropped`, not
   * silently adopted, and the head is left alone.
   */
  private adoptChainHead(
    messages: RoomMessage[],
    dropped: { hash: string; reason: string; kind: DropKind }[],
  ): void {
    const own = messages.filter(m => m.author === this.identity.pubkey);
    if (own.length === 0) {
      // the relay said nothing about this author; keep the head we hold.
      return;
    }
    own.sort((a, b) => a.seq - b.seq);
    const top = own[own.length - 1]!;
    if (top.seq < this.seq) {
      dropped.push({
        hash: top.hash,
        reason: `chain head rollback: room holds seq ${top.seq}, this author is at ${this.seq}`,
        kind: 'invalid',
      });
      return;
    }
    if (top.seq === this.seq) {
      if (top.hash !== this.head) {
        dropped.push({
          hash: top.hash,
          reason: `chain head rewrite: seq ${top.seq} does not match this author's head`,
          kind: 'invalid',
        });
      }
      return;
    }
    // extending: the record that continues our head must be in the reply and
    // linked, or the reply is skipping seqs this author would have signed.
    const next = own.find(m => m.seq === this.seq + 1);
    if (!next || next.prev !== this.head) {
      dropped.push({
        hash: top.hash,
        reason: `chain head gap: no record links to this author's head at seq ${this.seq}`,
        kind: 'invalid',
      });
      return;
    }
    this.seq = top.seq;
    this.head = top.hash;
  }

  /** this author's chain head - the seq the next message will carry, minus one. */
  chainHead(): { seq: number; hash: string } {
    return { seq: this.seq, hash: this.head };
  }

  /**
   * Parse + verify one opened message record. `kind` is the one it opened as, so
   * the record's own kind byte is checked against the key and AAD that carried
   * it: a public message cannot be replayed as an action, or as a direct message.
   */
  private async parse(
    plain: Uint8Array,
    epoch: number,
    kind: MessageKind,
    ctx: { appScopeHash: Uint8Array; shardHash: Uint8Array },
    plaintext = false,
  ): Promise<RoomMessage | string> {
    try {
      const body = decodeRecord(plain, kind, SIG_HEX / 2);
      if (typeof body === 'string') {
        return body;
      }
      const { sigAt, ...fields } = body;
      // a direct message has to be addressed to this member: the key already
      // enforces it, and this makes the record say so too.
      if (kind === 'dm' && fields.to !== this.identity.pubkey) {
        return 'dm not addressed here';
      }
      // an unsealed record proves its own window, and so does any record that
      // carries one; a record that does not match is refused, so neither a
      // relay nor a member can replay a line as if it were written now.
      const stale = windowError(body, epoch, plaintext);
      if (stale) {
        return stale;
      }
      // re-encode in the record's OWN version: a signature only verifies against
      // the layout its author wrote.
      const signed = signedMessage(
        recordBytes({ ...fields, kind }, body.version, body.epoch),
        body.version,
        ctx,
      );
      const sig = toHex(plain.subarray(sigAt, sigAt + SIG_HEX / 2));
      if (!(await this.identity.verify(signed, sig, fields.author))) {
        return 'bad signature';
      }
      return {
        hash: toHex(await sha256(concat([signed, fromHex(sig)]))),
        author: body.author,
        name: body.name,
        seq: body.seq,
        prev: body.prev,
        ts: body.ts,
        body: body.body,
        epoch,
        kind,
        ...(plaintext ? { plain: true } : {}),
        ...(body.to ? { to: body.to } : {}),
      };
    } catch (e) {
      return e instanceof Error ? e.message : 'malformed record';
    }
  }

  /**
   * Decode and verify one presence record: signed (0x04 on), in its window,
   * by the key it names. An unsigned presence record, which any member could
   * write for anyone, is refused.
   */
  private async verifyPresence(
    plain: Uint8Array,
    epoch: number,
    ctx: { appScopeHash: Uint8Array; shardHash: Uint8Array },
  ): Promise<DecodedFields | string> {
    const version = plain[0] ?? 0;
    if (ROOM_READ_VERSIONS.includes(version) && version < ROOM_BOUND_VERSION) {
      return 'unsigned presence';
    }
    const fan = decodeRecord(plain, 'presence', SIG_HEX / 2);
    if (typeof fan === 'string') {
      return fan;
    }
    const stale = windowError(fan, epoch, false);
    if (stale) {
      return stale;
    }
    const signed = signedMessage(
      recordBytes({ ...fan, kind: 'presence' }, fan.version, fan.epoch),
      fan.version,
      ctx,
    );
    const sig = toHex(plain.subarray(fan.sigAt, fan.sigAt + SIG_HEX / 2));
    return (await this.identity.verify(signed, sig, fan.author)) ? fan : 'bad signature';
  }

  private async shardOrThrow(epoch: number): Promise<string> {
    const { shard } = await this.coords(epoch);
    return shard;
  }
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

interface DecodedFields {
  /** the wire version the record was written in - the signature covers that layout. */
  version: number;
  /**
   * the window signed into a plain record (0 on a sealed record, whose window is
   * bound by the AEAD's AAD instead).
   */
  epoch: number;
  ts: number;
  seq: number;
  prev: string;
  author: string;
  /** the direct-message recipient ('' when the record is not a direct message). */
  to: string;
  name: string;
  body: string;
  /** where this record's signature starts (length-prefixed fields end here). */
  sigAt: number;
}

const u32From = (b: Uint8Array, at: number): number =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

/**
 * Read one length-prefixed field. The SDK's `lp`/`lpText` prefix with a big-endian
 * **u32** (its only integer encoding - see canonical.ts), so this reads four
 * bytes, not two.
 */
const lpFrom = (b: Uint8Array, at: number): { text: string; next: number } | null => {
  if (at + 4 > b.length) {
    return null;
  }
  const len = u32From(b, at);
  if (at + 4 + len > b.length) {
    return null;
  }
  return { text: dec.decode(b.subarray(at + 4, at + 4 + len)), next: at + 4 + len };
};

/**
 * Decode the signed fields of a record, or a reason string.
 *
 * `sigBytes` is how much follows the fields before the pad: 64 for a message
 * (the signature rides inside the sealed plaintext), 0 for a presence record
 * (its author is already authenticated by the AEAD's tag and the tag's owner).
 */
function decodeRecord(plain: Uint8Array, kind: RoomKind, sigBytes: number): DecodedFields | string {
  const version = plain[0] ?? 0;
  if (!ROOM_READ_VERSIONS.includes(version)) {
    return `unsupported record version ${version}`;
  }
  if (plain[1] !== KIND_BYTE[kind]) {
    return 'unexpected record kind';
  }
  if (plain.length < 2 + 4 + 4 + SHA256_BYTES + PUBKEY_HEX / 2) {
    return 'record too short';
  }
  let at = 2;
  // 0x03 carries the window the plain record was written in; older versions and
  // the sealed lane (bound by AAD) do not.
  let epoch = 0;
  if (version >= ROOM_PLAIN_VERSION) {
    epoch = u32From(plain, at);
    at += 4;
  }
  const ts = u32From(plain, at);
  at += 4;
  const seq = u32From(plain, at);
  at += 4;
  const prev = toHex(plain.subarray(at, at + SHA256_BYTES));
  at += SHA256_BYTES;
  const author = toHex(plain.subarray(at, at + PUBKEY_HEX / 2));
  at += PUBKEY_HEX / 2;
  // the recipient field only exists from 0x02 on; 0x01 went straight to the name.
  let to = '';
  if (version >= RECIPIENT_FIELD_VERSION) {
    const toRaw = plain.subarray(at, at + PUBKEY_HEX / 2);
    if (toRaw.length < PUBKEY_HEX / 2) {
      return 'record too short';
    }
    if (!toRaw.every(byte => byte === 0)) {
      to = toHex(toRaw);
    }
    at += PUBKEY_HEX / 2;
  }
  const name = lpFrom(plain, at);
  if (!name) {
    return 'malformed name field';
  }
  const body = lpFrom(plain, name.next);
  if (!body) {
    return 'malformed body field';
  }
  const sigAt = body.next;
  if (sigAt + sigBytes > plain.length) {
    return 'record too short for its signature';
  }
  // Only the pad may follow the signature; anything else means the plaintext was
  // not ours - or was ours and was edited.
  for (let i = sigAt + sigBytes; i < plain.length; i++) {
    if (plain[i] !== 0) {
      return 'non-zero padding';
    }
  }
  return {
    version,
    epoch,
    ts,
    seq,
    prev: seq === 1 ? '' : prev,
    author,
    to,
    name: name.text,
    body: body.text,
    sigAt,
  };
}

/**
 * A version this reader does not know is news about versions; anything else that
 * failed verification is the reader refusing a record it can see through.
 */
const dropKindFor = (reason: string): DropKind =>
  reason.startsWith('unsupported record version') ? 'unsupported' : 'invalid';

/**
 * The window a plain record claims must be the window it was served in, or the
 * reason it is refused.
 *
 * A sealed record's window is bound by the AEAD's AAD, but an unsealed record
 * has no AAD, so the only thing that can stop a relay from serving last window's
 * plain line (or presence) as this window's is the window the author signed into
 * the record - and a record old enough to predate that binding (version < 0x03)
 * cannot prove anything and is refused too.
 */
const plainWindowError = (body: DecodedFields, epoch: number): string | null => {
  if (body.version < ROOM_PLAIN_VERSION) {
    return 'plain record without a window';
  }
  return body.epoch === epoch ? null : 'plain record from another window';
};

/**
 * Every window check one record must pass, or the reason it fails: a plain
 * record must carry its window, any record that carries one must carry this
 * one, and the signed `ts` must sit in (or one window beside) the window.
 */
const windowError = (body: DecodedFields, epoch: number, plaintext: boolean): string | null => {
  if (plaintext) {
    const stale = plainWindowError(body, epoch);
    if (stale) {
      return stale;
    }
  } else if (body.version >= ROOM_PLAIN_VERSION && body.epoch !== epoch) {
    return 'record from another window';
  }
  return tsWindowError(body.ts, epoch);
};

/**
 * Enforce the per-author chain where the predecessor was seen in the same set.
 * A break is dropped with a reason: it means either an author rewrote their own
 * history, or a window was missed - and only the first is an attack, so the
 * caller gets the reason and decides what to show.
 */
function verifyChains(
  messages: RoomMessage[],
  dropped: { hash: string; reason: string; kind: DropKind }[],
): void {
  const byAuthor = new Map<string, RoomMessage[]>();
  for (const m of messages) {
    const list = byAuthor.get(m.author) ?? [];
    list.push(m);
    byAuthor.set(m.author, list);
  }
  for (const list of byAuthor.values()) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < list.length; i++) {
      const prevMsg = list[i - 1]!;
      const msg = list[i]!;
      if (msg.seq !== prevMsg.seq + 1) {
        continue;
      } // a gap, not a break
      if (msg.prev && msg.prev !== prevMsg.hash) {
        dropped.push({
          hash: msg.hash,
          reason: `chain break after seq ${prevMsg.seq}`,
          kind: 'invalid',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// invites
// ---------------------------------------------------------------------------

/**
 * What an invite carries: the room secret, its scope, and where to reach it.
 *
 * A bearer token through and through - whoever holds it reads and writes the
 * room, so it is handed over the way a password would be. The endpoint and token
 * are folded in because a community's room lives behind *their* bouncer, and a
 * newcomer has no other way to learn its address.
 */
export interface RoomInvite {
  appScope: string;
  /** the channel inside the scope, `#penumbra` when the invite predates channels. */
  channel: string;
  secret: Uint8Array;
  /**
   * The room is public: its board is addressed by the channel NAME, so a reader
   * holding no key can find it by typing the name (see {@link RoomConfig.public}).
   *
   * It has to travel with the invite, because it decides the coordinate the
   * guest derives: by name here, by the secret otherwise. Omitted (the default)
   * is the sealed case, where the guest needs nothing but the secret it was just
   * handed.
   */
  public?: boolean;
  /** relay endpoint the room was created against, so the guest can reach it. */
  endpoint?: string;
  /** bearer credential for a gated bouncer in front of that endpoint. */
  token?: string;
}

/** a fresh 32-byte room secret. */
export const createRoomSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(KEY_BYTES));

/**
 * Encode an invite. Deliberately a bearer token: whoever holds it can read and
 * write the room. Treat it like a password - it is the whole membership model of
 * this first cut.
 */
export const encodeInvite = (invite: RoomInvite): string => {
  const parts = [
    b64url(enc.encode(invite.appScope)),
    b64url(enc.encode(invite.channel)),
    b64url(invite.secret),
  ];
  // Endpoint and token are positional, so an invite without a token still names
  // a reachable (ungated) relay: four fields mean "…endpoint.token". The public
  // marker is one reserved character and therefore unambiguous, but it still
  // shifts them by one when it is there.
  if (invite.public) {
    parts.push(PUBLIC_FIELD);
  }
  if (invite.endpoint || invite.token) {
    // The endpoint slot is written even when empty, because a token written into
    // it would be read back as the relay's address.
    parts.push(invite.endpoint ? b64url(enc.encode(invite.endpoint)) : '');
  }
  if (invite.token) {
    parts.push(b64url(enc.encode(invite.token)));
  }
  return INVITE_PREFIX + parts.join('.');
};

/** parse an invite, or throw with the reason. */
export const parseInvite = (code: string): RoomInvite => {
  const trimmed = code.trim();
  const legacy = trimmed.startsWith(LEGACY_INVITE_PREFIX);
  if (!trimmed.startsWith(INVITE_PREFIX) && !legacy) {
    throw new Error(`invite must start with ${INVITE_PREFIX}`);
  }
  const fields = trimmed.slice((legacy ? LEGACY_INVITE_PREFIX : INVITE_PREFIX).length).split('.');

  // zroom1: scope.secret[.endpoint[.token]] - written before channels existed, so
  // it names no channel and means the default one.
  // zroom2: scope.channel.secret[.p][.endpoint[.token]] - `p` marks a public
  // room and shifts the optional fields by one when present.
  const [scopeField, second, third, fourth, fifth, sixth] = fields;
  const channelField = legacy ? undefined : second;
  const secretField = legacy ? second : third;
  const marked = !legacy && fourth === PUBLIC_FIELD;
  const endpointField = legacy ? third : marked ? fifth : fourth;
  const tokenField = legacy ? fourth : marked ? sixth : fifth;

  if (!scopeField || !secretField) {
    throw new Error('invite is missing its scope or secret');
  }
  const secret = fromB64url(secretField);
  if (secret.length !== KEY_BYTES) {
    throw new Error('invite secret is not 32 bytes');
  }

  return {
    appScope: dec.decode(fromB64url(scopeField)),
    // a channel field is base64 like everything else; the legacy default is not a
    // field at all and must not be run through the decoder.
    channel: channelField ? dec.decode(fromB64url(channelField)) : DEFAULT_CHANNEL,
    secret,
    // only when the invite says so: absent is the sealed default, not `false`.
    public: marked || undefined,
    endpoint: endpointField ? dec.decode(fromB64url(endpointField)) : undefined,
    token: tokenField ? dec.decode(fromB64url(tokenField)) : undefined,
  };
};
