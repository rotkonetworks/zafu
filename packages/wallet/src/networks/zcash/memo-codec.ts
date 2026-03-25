/**
 * memo-codec — binary memo format for structured Zcash memos
 *
 * Zcash memo field: 512 bytes (ZIP-302).
 * byte 0xF6 = arbitrary data. We use bytes 1-2 as a minimal header.
 *
 * Design: addresses ARE conversation endpoints (diversified addresses).
 * No session IDs in memos — the receiving diversifier index identifies
 * the conversation. FROST coordination, text chat, address sharing,
 * payment requests all use the same format.
 *
 * Single message: 3 bytes header → 509 bytes payload
 * Fragmented:    19 bytes header → 493 bytes per fragment
 */

// ── constants ──

export const MEMO_SIZE = 512;

/**
 * ZIP-302 memo type tags:
 *   0x00-0xF4 = UTF-8 text (strip trailing nulls)
 *   0xF5      = legacy arbitrary data (deprecated)
 *   0xF6 + all zeros = no memo
 *   0xF6 + non-zero  = RESERVED ("from the future")
 *   0xF7-0xFE = reserved
 *   0xFF      = arbitrary data (511 unconstrained bytes)
 *
 * We use 0xFF — the correct tag for custom structured binary data.
 */
const ARBITRARY_DATA = 0xff; // ZIP-302 §"Memo field format"

/**
 * Magic byte after 0xFF to identify zafu structured memos.
 * Distinguishes us from other wallets' arbitrary data.
 * 'Z' = 0x5A — easy to spot in hex dumps.
 */
const ZAFU_MAGIC = 0x5a;

/**
 * Layout (4-byte header for single, 20 for fragmented):
 *   byte 0: 0xFF (ZIP-302 arbitrary data)
 *   byte 1: 0x5A (zafu magic)
 *   byte 2: type (MemoType enum)
 *   byte 3: sequence (0x00=standalone, high nibble=part, low=total)
 *   bytes 4-19: messageId (only if fragmented)
 *   rest: payload
 */
export const PAYLOAD_SINGLE = MEMO_SIZE - 4; // 508
export const PAYLOAD_FRAGMENT = MEMO_SIZE - 20; // 492

// ── message types ──

export const enum MemoType {
  /** UTF-8 text message */
  Text = 0x01,
  /** unified address (raw bytes or bech32m string) */
  Address = 0x02,
  /** payment request (amount + optional address + optional label) */
  PaymentRequest = 0x03,
  /** read receipt / ack */
  Ack = 0x04,
  /** zafu contact card — name + address + TLV extensions */
  ContactCard = 0x05,
  /** zid-authenticated encrypted payload (sender-auth + forward secrecy) */
  EncryptedMessage = 0x06,
  /** generic structured data — content-type + correlation + payload */
  Data = 0x07,

  // FROST DKG (0x10-0x1f)
  DkgRound1 = 0x10,
  DkgRound2 = 0x11,
  DkgRound3 = 0x12,

  // FROST signing (0x20-0x2f)
  SignRequest = 0x20,
  SignCommitment = 0x21,
  SignShare = 0x22,
  SignResult = 0x23,
}

// ── parsed memo ──

export interface ParsedMemo {
  type: MemoType;
  /** message ID (16 bytes) — same across all fragments of one logical message */
  messageId: Uint8Array;
  /** 1-indexed part number (1 for standalone) */
  part: number;
  /** total parts (1 for standalone) */
  total: number;
  /** raw payload bytes */
  payload: Uint8Array;
}

// ── encode ──

/**
 * encode a single (non-fragmented) memo.
 * payload must fit in 509 bytes.
 */
export function encodeMemo(type: MemoType, payload: Uint8Array): Uint8Array {
  if (payload.length > PAYLOAD_SINGLE) {
    throw new Error(`payload ${payload.length} exceeds single memo capacity ${PAYLOAD_SINGLE}`);
  }
  const memo = new Uint8Array(MEMO_SIZE);
  memo[0] = ARBITRARY_DATA;
  memo[1] = ZAFU_MAGIC;
  memo[2] = type;
  memo[3] = 0x00; // standalone
  memo.set(payload, 4);
  return memo;
}

/**
 * encode a text message, automatically fragmenting if needed.
 * returns array of 512-byte memos ready to send as separate notes.
 */
export function encodeTextMessage(text: string): Uint8Array[] {
  const payload = new TextEncoder().encode(text);

  if (payload.length <= PAYLOAD_SINGLE) {
    return [encodeMemo(MemoType.Text, payload)];
  }

  return encodeFragmented(MemoType.Text, payload);
}

/**
 * encode arbitrary payload across multiple memos with fragmentation.
 * each memo shares the same 16-byte message ID.
 */
export function encodeFragmented(type: MemoType, payload: Uint8Array): Uint8Array[] {
  const totalParts = Math.ceil(payload.length / PAYLOAD_FRAGMENT);
  if (totalParts > 15) {
    throw new Error(`message too large: ${totalParts} fragments (max 15)`);
  }

  const messageId = crypto.getRandomValues(new Uint8Array(16));
  const memos: Uint8Array[] = [];

  for (let i = 0; i < totalParts; i++) {
    const start = i * PAYLOAD_FRAGMENT;
    const end = Math.min(start + PAYLOAD_FRAGMENT, payload.length);
    const chunk = payload.subarray(start, end);

    const memo = new Uint8Array(MEMO_SIZE);
    memo[0] = ARBITRARY_DATA;
    memo[1] = ZAFU_MAGIC;
    memo[2] = type;
    memo[3] = ((i + 1) << 4) | totalParts; // high nibble = part (1-indexed), low = total
    memo.set(messageId, 4);
    memo.set(chunk, 20);
    memos.push(memo);
  }

  return memos;
}

// ── decode ──

/**
 * decode a 512-byte memo. returns null for non-structured memos
 * (plain text, empty, or no-memo markers).
 */
export function decodeMemo(memo: Uint8Array): ParsedMemo | null {
  if (memo.length !== MEMO_SIZE) return null;
  if (memo[0] !== ARBITRARY_DATA) return null;
  if (memo[1] !== ZAFU_MAGIC) return null;

  const type = memo[2]! as MemoType;
  const seq = memo[3]!;

  if (seq === 0x00) {
    // standalone message — use deterministic ID from first 16 payload bytes
    // (so decoding the same memo twice produces the same ID)
    let end = MEMO_SIZE;
    if (type === MemoType.Text) {
      while (end > 4 && memo[end - 1] === 0) end--;
    }
    return {
      type,
      messageId: memo.slice(4, 20), // deterministic, not random
      part: 1,
      total: 1,
      payload: memo.slice(4, end),
    };
  }

  // fragmented
  const part = (seq >> 4) & 0x0f;
  const total = seq & 0x0f;
  const messageId = memo.slice(4, 20);

  let end = MEMO_SIZE;
  if (type === MemoType.Text && part === total) {
    // last text fragment: strip trailing zeros
    while (end > 20 && memo[end - 1] === 0) end--;
  }

  return {
    type,
    messageId,
    part,
    total,
    payload: memo.slice(20, end),
  };
}

// ── reassembly ──

/**
 * reassemble fragmented memos into a single payload.
 * fragments must all share the same messageId.
 * returns null if incomplete.
 */
export function reassemble(fragments: ParsedMemo[]): Uint8Array | null {
  if (fragments.length === 0) return null;

  const total = fragments[0]!.total;
  const expectedType = fragments[0]!.type;
  if (fragments.length < total) return null;

  // all fragments must have the same type
  if (!fragments.every(f => f.type === expectedType)) return null;

  // sort by part number
  const sorted = [...fragments].sort((a, b) => a.part - b.part);

  // verify completeness
  for (let i = 0; i < total; i++) {
    if (sorted[i]!.part !== i + 1) return null;
  }

  // concatenate payloads
  const totalBytes = sorted.reduce((sum, f) => sum + f.payload.length, 0);
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const f of sorted) {
    result.set(f.payload, offset);
    offset += f.payload.length;
  }
  return result;
}

// ── convenience helpers ──

/** decode text from a single or reassembled payload */
export function decodeText(payload: Uint8Array): string {
  return new TextDecoder().decode(payload);
}

/** encode a FROST DKG round message (hex blob) */
export function encodeDkgRound(round: 1 | 2 | 3, hexData: string): Uint8Array[] {
  const type = round === 1 ? MemoType.DkgRound1 : round === 2 ? MemoType.DkgRound2 : MemoType.DkgRound3;
  const payload = hexToBytes(hexData);
  if (payload.length <= PAYLOAD_SINGLE) {
    return [encodeMemo(type, payload)];
  }
  return encodeFragmented(type, payload);
}

/** encode a signing request (sighash + alpha hex) */
export function encodeSignRequest(sighashHex: string, alphasHex: string[]): Uint8Array[] {
  // pack as: [32 bytes sighash][N * 32 bytes alphas]
  const sighash = hexToBytes(sighashHex);
  const alphas = alphasHex.map(hexToBytes);
  const total = 32 + alphas.length * 32;
  const payload = new Uint8Array(total);
  payload.set(sighash, 0);
  let offset = 32;
  for (const a of alphas) {
    payload.set(a, offset);
    offset += 32;
  }
  if (payload.length <= PAYLOAD_SINGLE) {
    return [encodeMemo(MemoType.SignRequest, payload)];
  }
  return encodeFragmented(MemoType.SignRequest, payload);
}

/** encode an address share */
export function encodeAddress(address: string): Uint8Array {
  return encodeMemo(MemoType.Address, new TextEncoder().encode(address));
}

// ── hex helpers ──

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

// ── contact card ──

/**
 * Zafu Contact Card (MemoType 0x05)
 *
 * A contact card lets one zafu user share their name and receiving address
 * with another, privately, inside a zcash shielded memo. The recipient's
 * wallet detects the card and offers to save the sender as a contact.
 *
 * Design decisions:
 *
 *   Why binary, not text-delimited?
 *     Names can contain any UTF-8 character including colons, newlines, etc.
 *     Length-prefixed binary fields are unambiguous to parse — no escaping,
 *     no delimiter collision. Also more compact in the 508-byte budget.
 *
 *   Why not CBOR/protobuf?
 *     508 bytes is too tight for schema overhead. A hand-rolled 5-byte
 *     header is trivial to implement and audit. CBOR would buy us nothing
 *     here — there are only two variable-length fields.
 *
 *   Why no encryption on top of the memo?
 *     Zcash shielded memos are already encrypted to the recipient's
 *     incoming viewing key. Adding another layer would be redundant.
 *     The card is only readable by sender and recipient.
 *
 *   Why no checksum?
 *     The zcash note commitment scheme already provides authenticated
 *     encryption. Bit-flips are not possible without invalidating the
 *     note. A checksum would waste bytes for zero benefit.
 *
 *   Why u8 for name_len but u16be for addr_len?
 *     Names over 255 bytes (~125 CJK chars) are unreasonable for a
 *     contact name. Zcash unified addresses can reach ~350+ bytes with
 *     multiple receiver types (orchard + sapling + transparent), so u8
 *     (max 255) would be too small. u16be handles up to 65535.
 *
 *   Why version + "ignore trailing bytes"?
 *     Version byte lets us make breaking changes if needed. The trailing
 *     bytes rule (parsers MUST ignore bytes after the last defined field)
 *     lets us append optional fields in v1 without bumping the version.
 *     This is the same extensibility pattern used in DNS, TLS, and QUIC.
 *
 *   Why a flags byte?
 *     Cheap signal bits for wallet-to-wallet capability negotiation.
 *     A FROST participant can set bit 0 so the recipient knows signing
 *     requires threshold coordination. Future bits are reserved and MUST
 *     be zero on send, MUST be ignored on receive.
 *
 * Wire format (payload, max 508 bytes):
 *
 *   0      1       2          2+NL     3+NL        3+NL+AL
 *   ┌──────┬───────┬──────────┬────────┬───────────┬─────────┐
 *   │ ver  │ flags │ name_len │  name  │ addr_len  │ address │
 *   │ u8   │ u8    │ u8       │ UTF-8  │ u16be     │ UTF-8   │
 *   └──────┴───────┴──────────┴────────┴───────────┴─────────┘
 *
 *   ver:       0x01. MUST reject unknown versions.
 *   flags:     bitfield (bit 0 = FROST, bits 1-7 reserved).
 *   name_len:  u8, length of name in bytes. MAY be 0 (anonymous card).
 *   name:      UTF-8 display name. no null terminator.
 *   addr_len:  big-endian u16, length of address in bytes.
 *   address:   zcash unified address (bech32m string). REQUIRED.
 *   extensions: TLV (tag-length-value) entries until payload end.
 *              each: tag(u8) | len(u16be) | value(len bytes)
 *              parsers MUST skip unknown tags by reading len and advancing.
 *
 *              tag 0x01: ed25519 zid pubkey (len=32). DH messaging capable.
 *
 *              tag 0x02: post-quantum public key (algorithm-specific, future).
 *                        PQ keys (897+ bytes) exceed a single memo but the
 *                        card is fragmented across multiple notes when needed.
 *
 * Size budget:
 *   overhead: 5 bytes (ver + flags + name_len + addr_len)
 *   typical UA (~300 bytes): leaves ~203 bytes for name
 *   large UA (~400 bytes): leaves ~103 bytes for name (~50 CJK chars)
 */

export const CONTACT_CARD_VERSION = 0x01;

/**
 * Contact card flags byte.
 *
 * Capabilities are signaled by DATA PRESENCE, not flag bits:
 *   - zid present (tag 0x01)  → sender supports ed25519 DH messaging
 *   - pq key present (tag 0x02, future) → sender supports post-quantum
 *
 * The flags byte is reserved for behavioral signals that can't be
 * inferred from the data fields. All bits MUST be 0 on send,
 * MUST be ignored on receive, until assigned.
 */
export const enum ContactCardFlag {
  // all bits reserved — set to 0
}

export interface ContactCard {
  version: number;
  flags: number;
  name: string;
  address: string;
  /** sender's per-contact zid pubkey (32 bytes hex). optional in v1 — appended after address. */
  zid?: string;
}

/**
 * encode a contact card. returns one or more 512-byte memos.
 * automatically fragments when the card exceeds a single memo
 * (e.g. long addresses or future PQ key extensions).
 */
export function encodeContactCard(card: Omit<ContactCard, 'version'>): Uint8Array[] {
  const nameBytes = new TextEncoder().encode(card.name);
  const addrBytes = new TextEncoder().encode(card.address);

  if (nameBytes.length > 255) {
    throw new Error(`name too long: ${nameBytes.length} bytes (max 255)`);
  }
  if (addrBytes.length > 65535) {
    throw new Error(`address too long: ${addrBytes.length} bytes`);
  }

  // build extensions
  const extensions: Uint8Array[] = [];
  if (card.zid) {
    const zidBytes = hexToBytes(card.zid);
    if (zidBytes.length === 32) {
      const ext = new Uint8Array(3 + 32);
      ext[0] = 0x01; // tag: ed25519 zid
      ext[1] = 0x00; // len high
      ext[2] = 0x20; // len low (32)
      ext.set(zidBytes, 3);
      extensions.push(ext);
    }
  }

  const extTotal = extensions.reduce((s, e) => s + e.length, 0);
  const total = 1 + 1 + 1 + nameBytes.length + 2 + addrBytes.length + extTotal;

  const payload = new Uint8Array(total);
  let offset = 0;

  payload[offset++] = CONTACT_CARD_VERSION;
  payload[offset++] = card.flags & 0xff;
  payload[offset++] = nameBytes.length;
  payload.set(nameBytes, offset); offset += nameBytes.length;
  payload[offset++] = (addrBytes.length >> 8) & 0xff;
  payload[offset++] = addrBytes.length & 0xff;
  payload.set(addrBytes, offset); offset += addrBytes.length;
  for (const ext of extensions) {
    payload.set(ext, offset);
    offset += ext.length;
  }

  // single memo or fragmented
  if (total <= PAYLOAD_SINGLE) {
    return [encodeMemo(MemoType.ContactCard, payload)];
  }
  return encodeFragmented(MemoType.ContactCard, payload);
}

export function decodeContactCard(payload: Uint8Array): ContactCard | null {
  if (payload.length < 5) return null; // minimum: ver + flags + name_len(0) + addr_len(0)

  let offset = 0;

  const version = payload[offset++]!;
  if (version !== CONTACT_CARD_VERSION) return null; // unknown version

  const flags = payload[offset++]!;

  const nameLen = payload[offset++]!;
  if (offset + nameLen + 2 > payload.length) return null;
  const name = new TextDecoder().decode(payload.slice(offset, offset + nameLen));
  offset += nameLen;

  const addrLen = (payload[offset]! << 8) | payload[offset + 1]!;
  offset += 2;
  if (offset + addrLen > payload.length) return null;
  const address = new TextDecoder().decode(payload.slice(offset, offset + addrLen));
  offset += addrLen;

  if (!address) return null; // address is required

  // parse TLV extensions
  let zid: string | undefined;
  while (offset + 3 <= payload.length) {
    const tag = payload[offset]!;
    const len = (payload[offset + 1]! << 8) | payload[offset + 2]!;
    offset += 3;
    if (offset + len > payload.length) break; // truncated — stop
    if (tag === 0x01 && len === 32) {
      zid = bytesToHex(payload.slice(offset, offset + 32));
    }
    // unknown tags: skip by advancing offset
    offset += len;
  }

  return { version, flags, name, address, zid };
}

// ── generic data (agentic / machine-to-machine) ──

/**
 * Data memo content types.
 *
 * The Data message (0x07) carries machine-readable payloads with a
 * content type, optional correlation ID (for request/response), and
 * optional reply-to address.
 *
 * Wire format (payload after zafu header):
 *   byte 0:      content type (DataContentType enum)
 *   byte 1:      flags (bit 0 = has correlation ID, bit 1 = has reply-to)
 *   bytes 2-17:  correlation ID (16 bytes, present if flags bit 0)
 *   next 2+N:    reply-to address (u16be len + UTF-8, present if flags bit 1)
 *   rest:        application data
 */
export const enum DataContentType {
  /** raw bytes — receiver interprets based on context */
  Raw = 0x00,
  /** JSON (UTF-8 encoded) */
  Json = 0x01,
  /** CBOR (RFC 8949) */
  Cbor = 0x02,
  /** protobuf (caller defines schema out-of-band) */
  Protobuf = 0x03,
}

export const enum DataFlag {
  /** payload includes a 16-byte correlation ID for request/response linking */
  HasCorrelation = 1 << 0,
  /** payload includes a reply-to address */
  HasReplyTo = 1 << 1,
}

export interface DataMemo {
  contentType: DataContentType;
  correlationId?: Uint8Array;  // 16 bytes
  replyTo?: string;            // zcash address
  data: Uint8Array;            // application payload
}

export function encodeDataMemo(msg: DataMemo): Uint8Array[] {
  let flags = 0;
  if (msg.correlationId) flags |= DataFlag.HasCorrelation;
  if (msg.replyTo) flags |= DataFlag.HasReplyTo;

  const replyToBytes = msg.replyTo ? new TextEncoder().encode(msg.replyTo) : null;
  const headerSize = 2
    + (msg.correlationId ? 16 : 0)
    + (replyToBytes ? 2 + replyToBytes.length : 0);
  const total = headerSize + msg.data.length;

  const payload = new Uint8Array(total);
  let offset = 0;

  payload[offset++] = msg.contentType;
  payload[offset++] = flags;

  if (msg.correlationId) {
    payload.set(msg.correlationId.slice(0, 16), offset);
    offset += 16;
  }
  if (replyToBytes) {
    payload[offset++] = (replyToBytes.length >> 8) & 0xff;
    payload[offset++] = replyToBytes.length & 0xff;
    payload.set(replyToBytes, offset);
    offset += replyToBytes.length;
  }
  payload.set(msg.data, offset);

  if (total <= PAYLOAD_SINGLE) {
    return [encodeMemo(MemoType.Data, payload)];
  }
  return encodeFragmented(MemoType.Data, payload);
}

export function decodeDataMemo(payload: Uint8Array): DataMemo | null {
  if (payload.length < 2) return null;

  let offset = 0;
  const contentType = payload[offset++]! as DataContentType;
  const flags = payload[offset++]!;

  let correlationId: Uint8Array | undefined;
  if (flags & DataFlag.HasCorrelation) {
    if (offset + 16 > payload.length) return null;
    correlationId = payload.slice(offset, offset + 16);
    offset += 16;
  }

  let replyTo: string | undefined;
  if (flags & DataFlag.HasReplyTo) {
    if (offset + 2 > payload.length) return null;
    const len = (payload[offset]! << 8) | payload[offset + 1]!;
    offset += 2;
    if (offset + len > payload.length) return null;
    replyTo = new TextDecoder().decode(payload.slice(offset, offset + len));
    offset += len;
  }

  return {
    contentType,
    correlationId,
    replyTo,
    data: payload.slice(offset),
  };
}

/** check if a 512-byte memo is a zafu structured memo (0xFF 0x5A ...) */
export function isStructuredMemo(memo: Uint8Array): boolean {
  return memo.length === MEMO_SIZE && memo[0] === ARBITRARY_DATA && memo[1] === ZAFU_MAGIC;
}

/** human-readable type name */
export function memoTypeName(type: MemoType): string {
  switch (type) {
    case MemoType.Text: return 'message';
    case MemoType.Address: return 'address';
    case MemoType.PaymentRequest: return 'payment request';
    case MemoType.Ack: return 'read receipt';
    case MemoType.ContactCard: return 'contact card';
    case MemoType.EncryptedMessage: return 'encrypted message';
    case MemoType.Data: return 'data';
    case MemoType.DkgRound1: return 'DKG round 1';
    case MemoType.DkgRound2: return 'DKG round 2';
    case MemoType.DkgRound3: return 'DKG round 3';
    case MemoType.SignRequest: return 'sign request';
    case MemoType.SignCommitment: return 'commitment';
    case MemoType.SignShare: return 'signature share';
    case MemoType.SignResult: return 'signature';
    default: return `unknown (0x${(type as number).toString(16)})`;
  }
}
