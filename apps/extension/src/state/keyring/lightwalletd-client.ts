// Standard CompactTxStreamer over native gRPC (public lightwalletd rejects
// grpc-web with 415). Body framing matches grpc-web so fetch reads it, but the
// gRPC status sits in unreadable HTTP/2 trailers - so HTTP 200 + data = success.

import { eachField } from '../../net/proto-reader';
import { decodeLightdInfo, type LightdInfo } from './lightd-info';
import type { ChainTip, CompactAction, CompactBlock, Utxo, ZcashClient } from './zcash-backend';
import {
  encodeSubtreeRootsArg,
  parseSubtreeRootStream,
  type SubtreePool,
  type SubtreeRoot,
} from './subtree-roots';

const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer';

// Per-method response-size caps. A hostile endpoint can otherwise ship
// arbitrarily large bytes via Response.arrayBuffer() and OOM the worker.
// Sized for the maximum legitimate response on each method.
const MAX_RESP_BYTES: Record<string, number> = {
  GetLatestBlock: 1 << 12, // 4 KiB - BlockID is tiny
  GetTreeState: 1 << 17, // 128 KiB - orchard tree state is hex-encoded
  GetBlockRange: 64 << 20, // 64 MiB - block stream (legitimate range can be large)
  GetTransaction: 1 << 20, // 1 MiB - single tx
  GetMempoolTx: 16 << 20, // 16 MiB - mempool stream
  GetLatestTreeState: 1 << 17,
  GetLightdInfo: 1 << 12, // 4 KiB - small info struct
};
const DEFAULT_MAX_RESP_BYTES = 1 << 20; // 1 MiB

async function readBoundedBody(resp: Response, method: string): Promise<Uint8Array> {
  const cap = MAX_RESP_BYTES[method] ?? DEFAULT_MAX_RESP_BYTES;
  const cl = resp.headers.get('content-length');
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > cap) {
      throw new Error(`gRPC ${method}: declared response size ${n} exceeds cap ${cap}`);
    }
  }
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length > cap) {
      throw new Error(`gRPC ${method}: response ${buf.length} exceeds cap ${cap}`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.length;
      if (total > cap) {
        try {
          await reader.cancel();
        } catch {
          /* swallow */
        }
        throw new Error(`gRPC ${method}: response exceeded cap ${cap} mid-stream`);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class LightwalletdClient implements ZcashClient {
  private serverUrl: string;

  /** `signal`: the run this client serves; once it aborts, nothing more goes out */
  constructor(
    serverUrl: string,
    private readonly signal?: AbortSignal,
  ) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  async getTip(): Promise<ChainTip> {
    // GetLatestBlock(ChainSpec{}) → BlockID { uint64 height=1; bytes hash=2 }
    const resp = await this.grpcCall('GetLatestBlock', new Uint8Array(0));
    let height = 0;
    let hash: Uint8Array = new Uint8Array(0);
    eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 1) {
        height = Number(val as bigint);
      } else if (wire === 2 && field === 2) {
        hash = val as Uint8Array;
      }
    });
    return { height, hash };
  }

  async getTreeState(
    height: number,
  ): Promise<{ height: number; orchardTree: string; ironwoodTree?: string; time: number }> {
    // GetTreeState(BlockID{height=1}) → TreeState { height=2; time=4; orchardTree=6 }
    // NU6.3 adds ironwoodTree as the next field (7); absent pre-upgrade.
    const req = new Uint8Array([0x08, ...this.varint(height)]);
    const resp = await this.grpcCall('GetTreeState', req);
    let h = 0;
    let time = 0;
    let orchardTree = '';
    let ironwoodTree = '';
    const decoder = new TextDecoder();
    eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 2) {
        h = Number(val as bigint);
      } else if (wire === 0 && field === 4) {
        time = Number(val as bigint);
      } else if (wire === 2 && field === 6) {
        orchardTree = decoder.decode(val as Uint8Array);
      } else if (wire === 2 && field === 7) {
        ironwoodTree = decoder.decode(val as Uint8Array);
      }
    });
    return ironwoodTree
      ? { height: h, orchardTree, ironwoodTree, time }
      : { height: h, orchardTree, time };
  }

  async getCompactBlocks(startHeight: number, endHeight: number): Promise<CompactBlock[]> {
    // GetBlockRange(BlockRange{ start=1:BlockID{height=1}, end=2:BlockID{height=1} })
    const startId = [0x08, ...this.varint(startHeight)];
    const endId = [0x08, ...this.varint(endHeight)];
    const req = new Uint8Array([
      0x0a,
      ...this.lengthDelimited(new Uint8Array(startId)),
      0x12,
      ...this.lengthDelimited(new Uint8Array(endId)),
    ]);
    const resp = await this.grpcCallStream('GetBlockRange', req);
    return this.parseBlockStream(resp);
  }

  async getSubtreeRoots(pool: SubtreePool, startIndex: number): Promise<SubtreeRoot[]> {
    const resp = await this.grpcCallStream(
      'GetSubtreeRoots',
      encodeSubtreeRootsArg(pool, startIndex),
    );
    return parseSubtreeRootStream(resp);
  }

  async getAddressUtxos(address: string, startHeight = 0, maxEntries = 0): Promise<Utxo[]> {
    // GetAddressUtxos(GetAddressUtxosArg{ addresses=1 (one, never several), startHeight=2, maxEntries=3 })
    const parts: number[] = [0x0a, ...this.lengthDelimited(new TextEncoder().encode(address))];
    if (startHeight > 0) {
      parts.push(0x10, ...this.varint(startHeight));
    }
    if (maxEntries > 0) {
      parts.push(0x18, ...this.varint(maxEntries));
    }
    const resp = await this.grpcCall('GetAddressUtxos', new Uint8Array(parts));

    // GetAddressUtxosReplyList { addressUtxos=1 repeated GetAddressUtxosReply }
    const utxos: Utxo[] = [];
    eachField(resp, (field, wire, val) => {
      if (wire === 2 && field === 1) {
        utxos.push(this.parseUtxo(val as Uint8Array));
      }
    });
    return utxos;
  }

  async getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }> {
    // GetTransaction(TxFilter{ block=1, index=2, hash=3 }) → RawTransaction { data=1; height=2 }.
    // `txid` is in wire (internal) byte order, as CompactTx.hash and GetAddressUtxos carry it.
    const req = new Uint8Array([0x1a, ...this.lengthDelimited(txid)]);
    const resp = await this.grpcCall('GetTransaction', req);
    return this.parseRawTransaction(resp);
  }

  async getBlockTime(height: number): Promise<number> {
    // GetBlock(BlockID{height=1}) → CompactBlock { time=5 }
    const req = new Uint8Array([0x08, ...this.varint(height)]);
    const resp = await this.grpcCall('GetBlock', req);
    let time = 0;
    eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 5) {
        time = Number(val as bigint);
      }
    });
    return time;
  }

  async getLightdInfo(): Promise<LightdInfo> {
    // GetLightdInfo(Empty) → LightdInfo {
    //   version=1; vendor=2; chainName=4; saplingActivationHeight=5;
    //   consensusBranchId=6 (hex string); blockHeight=7; gitCommit=8;
    //   zcashdSubversion=14 }
    const resp = await this.grpcCall('GetLightdInfo', new Uint8Array(0));
    return decodeLightdInfo(resp);
  }

  async sendTransaction(
    txData: Uint8Array,
  ): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }> {
    // SendTransaction(RawTransaction{data=1}) → SendResponse{errorCode=1; errorMessage=2}; no txid, ok when errorCode===0
    const req = new Uint8Array([0x0a, ...this.lengthDelimited(txData)]);
    const resp = await this.grpcCall('SendTransaction', req);
    let errorCode = 0;
    let errorMessage = '';
    const decoder = new TextDecoder();
    eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 1) {
        errorCode = Number(val as bigint);
      } else if (wire === 2 && field === 2) {
        errorMessage = decoder.decode(val as Uint8Array);
      }
    });
    return { txid: new Uint8Array(0), errorCode, errorMessage };
  }

  // GetTaddressTxids streams whole RawTransactions, not ids; transparent history is not read from it yet.
  async getTaddressTxids(): Promise<Uint8Array[]> {
    return [];
  }

  // ── protobuf / grpc-web helpers ──

  private async grpcCall(method: string, msg: Uint8Array): Promise<Uint8Array> {
    const resp = await this.fetchGrpc(method, msg);
    const buf = await readBoundedBody(resp, method);

    if (buf.length < 5) {
      const status = resp.headers.get('grpc-status');
      if (status && status !== '0') {
        throw new Error(
          `gRPC ${method}: ${decodeURIComponent(resp.headers.get('grpc-message') ?? `status ${status}`)}`,
        );
      }
      throw new Error(`gRPC ${method}: empty response from ${this.serverUrl}`);
    }

    const flags = buf[0]!;
    if (flags & 0x80) {
      const trailerLen = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
      const trailer = new TextDecoder().decode(buf.subarray(5, 5 + trailerLen));
      const status = /grpc-status:\s*(\d+)/.exec(trailer)?.[1] ?? '0';
      if (status !== '0') {
        const m = /grpc-message:\s*(.+)/.exec(trailer)?.[1]?.trim();
        throw new Error(`gRPC ${method}: ${decodeURIComponent(m ?? `status ${status}`)}`);
      }
      return new Uint8Array(0);
    }

    const len = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
    return buf.subarray(5, 5 + len);
  }

  private async grpcCallStream(method: string, msg: Uint8Array): Promise<Uint8Array> {
    const resp = await this.fetchGrpc(method, msg);
    return readBoundedBody(resp, method);
  }

  private async fetchGrpc(method: string, msg: Uint8Array): Promise<Response> {
    const path = `${this.serverUrl}/${SERVICE}/${method}`;
    const body = new Uint8Array(5 + msg.length);
    body[1] = (msg.length >> 24) & 0xff;
    body[2] = (msg.length >> 16) & 0xff;
    body[3] = (msg.length >> 8) & 0xff;
    body[4] = msg.length & 0xff;
    body.set(msg, 5);

    const resp = await fetch(path, {
      method: 'POST',
      // native gRPC content-type - public lightwalletd rejects grpc-web (415)
      headers: { 'Content-Type': 'application/grpc' },
      body,
      signal: this.signal,
    });
    if (!resp.ok) {
      throw new Error(`gRPC ${method}: HTTP ${resp.status}`);
    }
    return resp;
  }

  private varint(n: number): number[] {
    const parts: number[] = [];
    while (n > 0x7f) {
      parts.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    parts.push(n);
    return parts;
  }

  private lengthDelimited(data: Uint8Array): number[] {
    return [...this.varint(data.length), ...data];
  }

  private parseBlockStream(buf: Uint8Array): CompactBlock[] {
    const blocks: CompactBlock[] = [];
    let pos = 0;
    while (pos < buf.length) {
      if (pos + 5 > buf.length) {
        break;
      }
      if (buf[pos]! & 0x80) {
        break;
      } // trailer frame
      // `<<24` yields a SIGNED int32: a declared length >= 2^31 parses
      // negative, the bounds check below passes, subarray clamps to empty and
      // `pos += len` walks BACKWARDS - an unbounded loop that pushes an object
      // every 5 bytes until the worker OOMs. A 9-byte hostile response was
      // enough. Use unsigned arithmetic and reject anything not a sane length.
      const len =
        buf[pos + 1]! * 0x1000000 + (buf[pos + 2]! << 16) + (buf[pos + 3]! << 8) + buf[pos + 4]!;
      pos += 5;
      if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
        break;
      }
      blocks.push(this.parseBlock(buf.subarray(pos, pos + len)));
      pos += len;
    }
    return blocks;
  }

  /** CompactBlock { height=2; hash=3; vtx=7 repeated CompactTx } */
  private parseBlock(buf: Uint8Array): CompactBlock {
    const block: CompactBlock = { height: 0, hash: new Uint8Array(0), actions: [] };
    eachField(buf, (field, wire, val) => {
      if (wire === 0 && field === 2) {
        block.height = Number(val as bigint);
      } else if (wire === 2 && field === 3) {
        block.hash = val as Uint8Array;
      } else if (wire === 2 && field === 7) {
        const { orchard, ironwood } = this.parseCompactTx(val as Uint8Array);
        for (const a of orchard) {
          block.actions.push(a);
        }
        for (const a of ironwood) {
          (block.ironwoodActions ??= []).push(a);
        }
      }
    });
    return block;
  }

  /**
   * CompactTx { hash=2 (txid); actions=6 orchard; ironwoodActions=9 }
   *
   * Field 9 is the finalized upstream lightwallet-protocol number for the
   * NU6.3 ironwood pool, so this decodes identically against zidecar, Zaino,
   * and canonical lightwalletd as each ships ironwood support. Ironwood
   * reuses the CompactOrchardAction shape, so parseAction serves both.
   */
  private parseCompactTx(buf: Uint8Array): {
    orchard: CompactAction[];
    ironwood: CompactAction[];
  } {
    let txid: Uint8Array = new Uint8Array(0);
    const rawActions: Uint8Array[] = [];
    const rawIronwood: Uint8Array[] = [];
    eachField(buf, (field, wire, val) => {
      if (wire === 2 && field === 2) {
        txid = val as Uint8Array;
      } else if (wire === 2 && field === 6) {
        rawActions.push(val as Uint8Array);
      } else if (wire === 2 && field === 9) {
        rawIronwood.push(val as Uint8Array);
      }
    });
    // CompactTx.hash (field 2) is the txid in INTERNAL / wire byte order - the
    // lightwallet-protocol standard. But the rest of the wallet stores txids in
    // DISPLAY order: resolveBroadcastTxid reverses compute_txid to display, and
    // zidecar's native inline action txid is already display order. So reverse
    // here to the one convention every txid comparison uses. Without this, on a
    // lightwalletd backend a sent tx's scanned note carries a wire-order txid
    // that never matches the display-order `sent` record, and the payment shows
    // "unconfirmed" forever even though its block was scanned.
    const txidDisplay = txid.length === 32 ? Uint8Array.from(txid).reverse() : txid;
    const build = (raws: Uint8Array[]) =>
      raws.map(raw => {
        const a = this.parseAction(raw);
        a.txid = txidDisplay;
        return a;
      });
    return { orchard: build(rawActions), ironwood: build(rawIronwood) };
  }

  /** CompactOrchardAction { nullifier=1; cmx=2; ephemeralKey=3; ciphertext=4 } */
  private parseAction(buf: Uint8Array): CompactAction {
    const a: CompactAction = {
      cmx: new Uint8Array(0),
      ephemeralKey: new Uint8Array(0),
      ciphertext: new Uint8Array(0),
      nullifier: new Uint8Array(0),
      txid: new Uint8Array(0),
    };
    eachField(buf, (field, wire, val) => {
      if (wire !== 2) {
        return;
      }
      const data = val as Uint8Array;
      if (field === 1) {
        a.nullifier = data;
      } else if (field === 2) {
        a.cmx = data;
      } else if (field === 3) {
        a.ephemeralKey = data;
      } else if (field === 4) {
        a.ciphertext = data;
      }
    });
    return a;
  }

  /** GetAddressUtxosReply { txid=1; index=2; script=3; valueZat=4; height=5; address=6 } */
  private parseUtxo(buf: Uint8Array): Utxo {
    const decoder = new TextDecoder();
    const utxo: Utxo = {
      address: '',
      txid: new Uint8Array(0),
      outputIndex: 0,
      script: new Uint8Array(0),
      valueZat: 0n,
      height: 0,
    };
    eachField(buf, (field, wire, val) => {
      if (wire === 0) {
        const v = val as bigint;
        if (field === 2) {
          utxo.outputIndex = Number(v);
        } else if (field === 4) {
          utxo.valueZat = v;
        } else if (field === 5) {
          utxo.height = Number(v);
        }
      } else if (wire === 2) {
        const data = val as Uint8Array;
        if (field === 1) {
          utxo.txid = data;
        } else if (field === 3) {
          utxo.script = data;
        } else if (field === 6) {
          utxo.address = decoder.decode(data);
        }
      }
    });
    return utxo;
  }

  /** RawTransaction { data=1; height=2 } */
  private parseRawTransaction(buf: Uint8Array): { data: Uint8Array; height: number } {
    let data: Uint8Array = new Uint8Array(0);
    let height = 0;
    eachField(buf, (field, wire, val) => {
      if (wire === 2 && field === 1) {
        data = val as Uint8Array;
      } else if (wire === 0 && field === 2) {
        height = Number(val as bigint);
      }
    });
    return { data, height };
  }
}
