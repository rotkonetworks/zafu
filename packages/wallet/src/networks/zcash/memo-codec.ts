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
  /** zafu contact card — name + address + optional flags */
  ContactCard = 0x05,

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
 *   trailing:  MUST be ignored by parsers.
 *
 * Size budget:
 *   overhead: 5 bytes (ver + flags + name_len + addr_len)
 *   typical UA (~300 bytes): leaves ~203 bytes for name
 *   large UA (~400 bytes): leaves ~103 bytes for name (~50 CJK chars)
 */

export const CONTACT_CARD_VERSION = 0x01;

export const enum ContactCardFlag {
  /** sender participates in FROST multisig */
  Frost = 1 << 0,
}

export interface ContactCard {
  version: number;
  flags: number;
  name: string;
  address: string;
}

export function encodeContactCard(card: Omit<ContactCard, 'version'>): Uint8Array {
  const nameBytes = new TextEncoder().encode(card.name);
  const addrBytes = new TextEncoder().encode(card.address);

  if (nameBytes.length > 255) {
    throw new Error(`name too long: ${nameBytes.length} bytes (max 255)`);
  }
  if (addrBytes.length > 65535) {
    throw new Error(`address too long: ${addrBytes.length} bytes`);
  }

  const total = 1 + 1 + 1 + nameBytes.length + 2 + addrBytes.length;
  if (total > PAYLOAD_SINGLE) {
    throw new Error(`contact card ${total} bytes exceeds memo capacity ${PAYLOAD_SINGLE}`);
  }

  const payload = new Uint8Array(total);
  let offset = 0;

  payload[offset++] = CONTACT_CARD_VERSION;
  payload[offset++] = card.flags & 0xff;
  payload[offset++] = nameBytes.length;
  payload.set(nameBytes, offset); offset += nameBytes.length;
  payload[offset++] = (addrBytes.length >> 8) & 0xff; // u16be high
  payload[offset++] = addrBytes.length & 0xff;        // u16be low
  payload.set(addrBytes, offset);

  return encodeMemo(MemoType.ContactCard, payload);
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

  if (!address) return null; // address is required

  return { version, flags, name, address };
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
