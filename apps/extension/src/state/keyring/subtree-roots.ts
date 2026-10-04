// lightwalletd GetSubtreeRoots, shared by both backends: the standard
// CompactTxStreamer rpc every light wallet calls, so asking it marks nothing.

export type SubtreePool = 'orchard' | 'ironwood';

export interface SubtreeRoot {
  rootHash: Uint8Array;
  completingBlockHeight: number;
}

// ShieldedProtocol { sapling = 0; orchard = 1; ironwood = 2 }
const PROTOCOL: Record<SubtreePool, number> = { orchard: 1, ironwood: 2 };

const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};

/** GetSubtreeRootsArg { startIndex = 1; shieldedProtocol = 2; maxEntries = 3 } */
export const encodeSubtreeRootsArg = (
  pool: SubtreePool,
  startIndex: number,
  maxEntries = 0,
): Uint8Array =>
  new Uint8Array([
    0x08,
    ...varint(startIndex),
    0x10,
    PROTOCOL[pool],
    ...(maxEntries > 0 ? [0x18, ...varint(maxEntries)] : []),
  ]);

/** SubtreeRoot { rootHash = 2; completingBlockHash = 3; completingBlockHeight = 4 } */
const parseSubtreeRoot = (buf: Uint8Array): SubtreeRoot => {
  let rootHash = new Uint8Array(0);
  let completingBlockHeight = 0;
  let pos = 0;
  const readVarint = (): number => {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 10 && pos < buf.length; i++) {
      const b = buf[pos++]!;
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) {
        break;
      }
    }
    return v;
  };
  while (pos < buf.length) {
    const tag = readVarint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      const v = readVarint();
      if (field === 4) {
        completingBlockHeight = v;
      }
    } else if (wire === 2) {
      const len = readVarint();
      if (pos + len > buf.length) {
        throw new Error('GetSubtreeRoots: truncated field');
      }
      if (field === 2) {
        rootHash = buf.slice(pos, pos + len);
      }
      pos += len;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error(`GetSubtreeRoots: wire type ${wire}`);
    }
  }
  if (rootHash.length !== 32) {
    throw new Error(`GetSubtreeRoots: root of ${rootHash.length} bytes`);
  }
  return { rootHash, completingBlockHeight };
};

/** the data frames of a (grpc or grpc-web) server stream, up to its trailer */
export const parseSubtreeRootStream = (buf: Uint8Array): SubtreeRoot[] => {
  const roots: SubtreeRoot[] = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flags = buf[pos]!;
    const len =
      buf[pos + 1]! * 0x1000000 + (buf[pos + 2]! << 16) + (buf[pos + 3]! << 8) + buf[pos + 4]!;
    pos += 5;
    if (pos + len > buf.length) {
      throw new Error('GetSubtreeRoots: truncated frame');
    }
    if (flags & 0x80) {
      const trailer = new TextDecoder().decode(buf.subarray(pos, pos + len));
      const status = /grpc-status:\s*(\d+)/.exec(trailer)?.[1] ?? '0';
      if (status !== '0') {
        const msg = /grpc-message:\s*(.+)/.exec(trailer)?.[1]?.trim();
        throw new Error(`gRPC GetSubtreeRoots: ${decodeURIComponent(msg ?? `status ${status}`)}`);
      }
      break;
    }
    roots.push(parseSubtreeRoot(buf.subarray(pos, pos + len)));
    pos += len;
  }
  return roots;
};
