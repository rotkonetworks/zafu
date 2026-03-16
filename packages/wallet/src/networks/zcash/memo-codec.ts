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
const ARBITRARY_DATA = 0xf6; // ZIP-302

/** max payload bytes per memo */
export const PAYLOAD_SINGLE = MEMO_SIZE - 3; // 509
export const PAYLOAD_FRAGMENT = MEMO_SIZE - 19; // 493

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
  memo[1] = type;
  memo[2] = 0x00; // standalone
  memo.set(payload, 3);
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
    memo[1] = type;
    memo[2] = ((i + 1) << 4) | totalParts; // high nibble = part (1-indexed), low = total
    memo.set(messageId, 3);
    memo.set(chunk, 19);
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

  const type = memo[1]! as MemoType;
  const seq = memo[2]!;

  if (seq === 0x00) {
    // standalone message
    // find end of payload (strip trailing zeros for text)
    let end = MEMO_SIZE;
    if (type === MemoType.Text) {
      while (end > 3 && memo[end - 1] === 0) end--;
    }
    return {
      type,
      messageId: crypto.getRandomValues(new Uint8Array(16)), // synthetic ID for standalone
      part: 1,
      total: 1,
      payload: memo.slice(3, end),
    };
  }

  // fragmented
  const part = (seq >> 4) & 0x0f;
  const total = seq & 0x0f;
  const messageId = memo.slice(3, 19);

  let end = MEMO_SIZE;
  if (type === MemoType.Text && part === total) {
    // last text fragment: strip trailing zeros
    while (end > 19 && memo[end - 1] === 0) end--;
  }

  return {
    type,
    messageId,
    part,
    total,
    payload: memo.slice(19, end),
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
  if (fragments.length < total) return null;

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

/** check if a 512-byte memo is one of our structured types */
export function isStructuredMemo(memo: Uint8Array): boolean {
  return memo.length === MEMO_SIZE && memo[0] === ARBITRARY_DATA && memo[1]! >= 0x01;
}

/** human-readable type name */
export function memoTypeName(type: MemoType): string {
  switch (type) {
    case MemoType.Text: return 'message';
    case MemoType.Address: return 'address';
    case MemoType.PaymentRequest: return 'payment request';
    case MemoType.Ack: return 'read receipt';
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
