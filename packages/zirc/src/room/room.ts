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
 *   one coordinate  (appScope, epoch, channelShard)
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
 *   authenticity     every record is signed by its author's ed25519 key and the
 *                    signature covers the room, the window and the sequence
 *                    number, so a member cannot rewrite another's message or
 *                    replay one into a different window (the AEAD's AAD binds the
 *                    window too).
 *   tamper-evidence  each author's records form a hash chain (`prev`). Rewriting
 *                    your own history is detectable by anyone who saw the earlier
 *                    link.
 *   fixed-size writes  every message blob is the same length, so the relay cannot
 *                    tell a one-character reply from a paragraph.
 *
 * What it does NOT guarantee, stated plainly:
 *
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
export const ROOM_VERSION = 0x02;

/** versions a reader will open, newest first. */
const ROOM_READ_VERSIONS: readonly number[] = [0x02, 0x01];

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
  /** injectable clock, seconds. Defaults to `Date.now()`. Tests pass one. */
  now?: () => number;
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
export type DropKind = 'invalid' | 'unsupported' | 'unreachable';

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
  if (s.length % 2 !== 0) throw new Error('room: odd-length hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
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
  // `extra` binds a key to one more thing - a direct message's recipient, so the
  // whole room can seal to a member and only that member can open it. Absent (the
  // default) it contributes no bytes at all, which keeps every other key exactly
  // as it was.
  if (extra) parts.push(extra);
  const raw = await hkdfBytes(secret, label, concat(parts), KEY_BYTES);
  return crypto.subtle.importKey('raw', ab(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
};

/** the channel a room defaults to when nobody named one. */
export const DEFAULT_CHANNEL = '#penumbra';

/**
 * The shard a channel lives on, inside a relay scope.
 *
 * The relay addresses every board by `(appScope, epoch, shard)`, and this is the
 * shard: derived from the channel's NAME and NOT from the room key. Two reasons,
 * both deliberate -
 *
 *   - a member's sealed records and a visitor's unsealed ones have to land in one
 *     place, so a visitor holding no key must still be able to find it;
 *   - a scope can then hold as many channels as it likes (`#penumbra`, `#trading`,
 *     `#offtopic`), each its own coordinate, on one relay, with no per-channel
 *     configuration on the relay at all.
 *
 * It was never secret from the relay - the relay addresses by it - and the
 * sealing, not the coordinate, is what keeps the sealed lane private.
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
  if (blob.length <= 1 + NONCE_BYTES + GCM_TAG_BYTES || blob[0] !== BLOB_VERSION) return null;
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

/** the signed payload: version ‖ kind ‖ ts ‖ seq ‖ prev ‖ author ‖ name ‖ body. */
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
): Uint8Array =>
  concat([
    Uint8Array.of(version, KIND_BYTE[r.kind]),
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

/** max body bytes that still fit one record. Callers get a clear error, not a cut. */
export const maxBodyBytes = (name: string, to = ''): number =>
  ROOM_PLAINTEXT_BYTES -
  (recordBytes({
    kind: 'msg',
    ts: 0,
    seq: 0,
    prev: '',
    author: '0'.repeat(PUBKEY_HEX),
    to,
    name,
    body: '',
  }).length +
    SIG_HEX / 2);

/** the room, as seen by one member. */
export class Room {
  private readonly secret: Uint8Array;
  private readonly appScope: string;
  private readonly appScopeHash: Uint8Array;
  private readonly shardHash: Uint8Array;
  private readonly channel: string;
  private readonly historyWindows: number;
  private readonly now: () => number;
  private readonly relay: RelayTransport;
  private readonly shardPin: string | undefined;

  /** epoch -> (shard) resolved once; the relay coordinate never changes. */
  private shard: string | null = null;

  /**
   * This author's chain head. Every message carries its own `seq` and the hash
   * of the one before it, and the tag is keyed by `seq` - so two messages with
   * the same seq are the same entry as far as the relay is concerned, and the
   * second would overwrite the first. The counter therefore lives here, never in
   * a caller's default, and {@link sync} adopts whatever the room already holds
   * so a reload continues the chain instead of colliding with it.
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
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.relay = config.relay;
    this.shardPin = config.shard;
  }

  /** resolve derived coordinates once, then reuse. */
  private async coords(): Promise<{
    shard: string;
    shardHash: Uint8Array;
    appScopeHash: Uint8Array;
  }> {
    if (!this.shard) {
      this.shard = this.shardPin ?? (await roomShard(this.appScope, this.channel));
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
   * recipient's pubkey, so every member can seal to any other and only that other
   * can open. The recipient finds it by trying that key on entries the room key
   * did not open - the sender never appears in the clear, so the relay learns
   * nothing about who is talking to whom beyond "an entry appeared".
   *
   * The room's shared secret is what makes this work without a key exchange, and
   * it is also the limit: anyone in the room can seal *to* you (that is how the
   * key is defined), so a member can spam your slot. They cannot read it, and they
   * cannot replace what you sent - tags are random per write.
   */
  async sendDirect(
    to: string,
    body: string,
    opts: { name?: string; epoch?: number } = {},
  ): Promise<RoomMessage> {
    if (to === this.identity.pubkey) throw new Error('room: a direct message needs a recipient');
    if (to.length !== PUBKEY_HEX) throw new Error('room: recipient must be a 64-char public key');
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
    const { shardHash, appScopeHash } = await this.coords();
    const epoch = opts.epoch ?? this.currentEpoch();
    const name = opts.name ?? this.identity.name ?? this.identity.pubkey.slice(0, 8);
    const to = opts.to ?? '';
    const bytes = enc.encode(body);
    const room = maxBodyBytes(name, to);
    if (bytes.length > room) {
      throw new Error(`room: message is ${bytes.length} bytes, the limit is ${room}`);
    }

    const seq = opts.seq ?? this.seq + 1;
    const prev = opts.prev ?? (seq === 1 ? '' : this.head);
    const ts = this.now();
    const rec = { kind, ts, seq, prev, author: this.identity.pubkey, to, name, body };
    const signed = recordBytes(rec);
    const sig = await this.identity.sign(signed);
    if (sig.length !== SIG_HEX) throw new Error('room: identity returned a malformed signature');

    const hash = toHex(await sha256(concat([signed, fromHex(sig)])));
    const sigBytes = fromHex(sig);
    const plaintext = new Uint8Array(ROOM_PLAINTEXT_BYTES);
    plaintext.set(concat([signed, sigBytes]));
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
      shard: await this.shardOrThrow(),
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
    const { shardHash, appScopeHash } = await this.coords();
    const win = opts.epoch ?? this.currentEpoch();
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
    const plaintext = new Uint8Array(ROOM_PLAINTEXT_BYTES);
    plaintext.set(recordBytes(rec));
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
      shard: await this.shardOrThrow(),
      entries: [{ tag, blob }],
    });
  }

  /**
   * Read the last `historyWindows` windows, oldest first, and verify everything.
   * Records that do not authenticate are dropped - not shown as "unknown", not
   * trusted - and reported so a caller can say how many were refused.
   */
  async sync(epochs = this.historyWindows): Promise<RoomSync> {
    const { shardHash, appScopeHash } = await this.coords();
    const current = this.currentEpoch();
    const windows = Array.from({ length: epochs }, (_, i) => current - (epochs - 1 - i)).filter(
      e => e >= 0,
    );

    const keysFor = new Map<number, { msg: CryptoKey; presence: CryptoKey; dm: CryptoKey }>();
    const dropped: { hash: string; reason: string; kind: DropKind }[] = [];
    const messages: RoomMessage[] = [];
    const present: RoomPresence[] = [];
    let sealed = 0;
    const seen = new Set<string>();

    for (const epoch of windows) {
      let entries: PresenceEntry[];
      try {
        entries = await this.relay.getBucket({
          appScope: this.appScope,
          epoch,
          shard: await this.shardOrThrow(),
        });
      } catch (e) {
        dropped.push({
          hash: `window:${epoch}`,
          reason: e instanceof Error ? e.message : 'fetch failed',
          kind: 'unreachable',
        });
        continue;
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
          // the direct-message key is derived for THIS member as recipient; any
          // room member can compute it to seal to me, and only I can open with it.
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
            if (plain) opened = { kind: 'presence', plain, plaintext: false };
          }
          if (!opened) {
            const plain = await open(
              keys.dm,
              aad(appScopeHash, shardHash, epoch, 'dm'),
              entry.blob,
            );
            if (plain) opened = { kind: 'dm', plain, plaintext: false };
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
          const fan = decodePresence(opened.plain);
          if (typeof fan === 'string') {
            dropped.push({ hash: toHex(entry.tag), reason: fan, kind: dropKindFor(fan) });
            continue;
          }
          present.push({
            author: fan.author,
            name: fan.name,
            epoch,
            ...(opened.plaintext ? { plain: true } : {}),
          });
          continue;
        }

        const parsed = await this.parse(opened.plain, epoch, opened.kind, opened.plaintext);
        if (typeof parsed === 'string') {
          dropped.push({ hash: toHex(entry.tag), reason: parsed, kind: dropKindFor(parsed) });
          continue;
        }
        if (seen.has(parsed.hash)) continue;
        seen.add(parsed.hash);
        messages.push(parsed);
      }
    }

    messages.sort((a, b) => a.epoch - b.epoch || a.ts - b.ts || (a.author < b.author ? -1 : 1));
    verifyChains(messages, dropped);
    this.adoptChainHead(messages);
    return { messages, present, dropped, sealed };
  }

  /**
   * Continue this author's chain from what the room holds: the highest seq we
   * sent, and its hash as the next `prev`. Called on every sync so a reload, a
   * second tab, or another device picks up where the previous one stopped.
   */
  private adoptChainHead(messages: RoomMessage[]): void {
    for (const m of messages) {
      if (m.author !== this.identity.pubkey) continue;
      if (m.seq > this.seq) {
        this.seq = m.seq;
        this.head = m.hash;
      }
    }
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
    plaintext = false,
  ): Promise<RoomMessage | string> {
    try {
      const body = decodeRecord(plain, kind, SIG_HEX / 2);
      if (typeof body === 'string') return body;
      const { sigAt, ...fields } = body;
      // a direct message has to be addressed to this member: the key already
      // enforces it, and this makes the record say so too.
      if (kind === 'dm' && fields.to !== this.identity.pubkey) return 'dm not addressed here';
      // re-encode in the record's OWN version: a signature only verifies against
      // the layout its author wrote.
      const signed = recordBytes({ ...fields, kind }, body.version);
      const sig = toHex(plain.subarray(sigAt, sigAt + SIG_HEX / 2));
      if (!(await this.identity.verify(signed, sig, fields.author))) return 'bad signature';
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

  private async shardOrThrow(): Promise<string> {
    const { shard } = await this.coords();
    return shard;
  }
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

interface DecodedFields {
  /** the wire version the record was written in - the signature covers that layout. */
  version: number;
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
  if (at + 4 > b.length) return null;
  const len = u32From(b, at);
  if (at + 4 + len > b.length) return null;
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
  if (!ROOM_READ_VERSIONS.includes(version)) return `unsupported record version ${version}`;
  if (plain[1] !== KIND_BYTE[kind]) return 'unexpected record kind';
  if (plain.length < 2 + 4 + 4 + SHA256_BYTES + PUBKEY_HEX / 2) return 'record too short';
  let at = 2;
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
    if (toRaw.length < PUBKEY_HEX / 2) return 'record too short';
    if (!toRaw.every(byte => byte === 0)) to = toHex(toRaw);
    at += PUBKEY_HEX / 2;
  }
  const name = lpFrom(plain, at);
  if (!name) return 'malformed name field';
  const body = lpFrom(plain, name.next);
  if (!body) return 'malformed body field';
  const sigAt = body.next;
  if (sigAt + sigBytes > plain.length) return 'record too short for its signature';
  // Only the pad may follow the signature; anything else means the plaintext was
  // not ours - or was ours and was edited.
  for (let i = sigAt + sigBytes; i < plain.length; i++) {
    if (plain[i] !== 0) return 'non-zero padding';
  }
  return {
    version,
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

function decodePresence(plain: Uint8Array): DecodedFields | string {
  return decodeRecord(plain, 'presence', 0);
}

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
      if (msg.seq !== prevMsg.seq + 1) continue; // a gap, not a break
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
  // a reachable (ungated) relay: four fields mean "…endpoint.token".
  if (invite.endpoint) parts.push(b64url(enc.encode(invite.endpoint)));
  if (invite.token) parts.push(b64url(enc.encode(invite.token)));
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
  const [scopeField, second, third, fourth, fifth] = fields;
  const channelField = legacy ? undefined : second;
  const secretField = legacy ? second : third;
  const endpointField = legacy ? third : fourth;
  const tokenField = legacy ? fourth : fifth;

  if (!scopeField || !secretField) throw new Error('invite is missing its scope or secret');
  const secret = fromB64url(secretField);
  if (secret.length !== KEY_BYTES) throw new Error('invite secret is not 32 bytes');

  return {
    appScope: dec.decode(fromB64url(scopeField)),
    // a channel field is base64 like everything else; the legacy default is not a
    // field at all and must not be run through the decoder.
    channel: channelField ? dec.decode(fromB64url(channelField)) : DEFAULT_CHANNEL,
    secret,
    endpoint: endpointField ? dec.decode(fromB64url(endpointField)) : undefined,
    token: tokenField ? dec.decode(fromB64url(tokenField)) : undefined,
  };
};
