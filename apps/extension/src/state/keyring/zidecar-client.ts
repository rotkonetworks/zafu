/**
 * zidecar grpc-web client
 *
 * rotko-hosted zidecar: the standard lightwalletd calls plus mempool watch.
 * Trusted for chain data, as any node.
 * uses raw protobuf encoding (no grpc-web library needed)
 */

import { grpcWebFetch, grpcWebUnaryMessage } from '../../net/grpc-web';
import { eachField, int32, WIRE_LEN, WIRE_VARINT } from '../../net/proto-reader';
import { decodeLightdInfo, type LightdInfo } from './lightd-info';
import type { FlyProof } from '../../workers/fly-verify';
import {
  encodeSubtreeRootsArg,
  parseSubtreeRootStream,
  type SubtreePool,
  type SubtreeRoot,
} from './subtree-roots';
import type { ChainTip, CompactAction, CompactBlock, Utxo } from './zcash-types';

/**
 * zebra's answer to a transaction it already has: in its mempool, queued, or
 * mined. A broadcast sent again (nym took another route after the first try
 * went unanswered) hears this, and it means the send went through.
 */
const ALREADY_SENT = /already exists in mempool|already queued for download|already in state/;

/** a SendResponse error that is the node already holding this very transaction */
export const alreadySent = (errorMessage: string): boolean => ALREADY_SENT.test(errorMessage);

export type { ChainTip, CompactAction, CompactBlock, Utxo } from './zcash-types';

export interface ProRing {
  ringKeys: string[]; // hex-encoded 32-byte Bandersnatch pubkeys
  commitment: Uint8Array; // 144-byte ring commitment
  epoch: string; // YYYY-MM-DD
  context: string; // VRF context string (includes server nonce)
  ringSize: number;
}

export interface LicenseInfo {
  zid: string;
  plan: string;
  expires: number;
  signature: string;
  totalPaidZat: number;
}

export class ZidecarClient {
  private serverUrl: string;

  /** `signal`: the run this client serves; once it aborts, nothing more goes out */
  constructor(
    serverUrl: string,
    private readonly signal?: AbortSignal,
  ) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  /** check license status for a ZID (scans on-chain payments) */
  async checkLicense(zid: string, ringPubkey?: Uint8Array): Promise<LicenseInfo> {
    // LicenseRequest: field 1 = zid_pubkey (string), field 9 = ring_pubkey (bytes)
    const zidBytes = new TextEncoder().encode(zid);
    const parts: number[] = [0x0a, ...this.lengthDelimited(zidBytes)];
    if (ringPubkey?.length === 32) {
      // field 9, wire type 2 (length-delimited): tag = (9 << 3) | 2 = 0x4a
      parts.push(0x4a, ...this.lengthDelimited(ringPubkey));
    }
    const resp = await this.grpcCall('GetLicense', new Uint8Array(parts));
    return this.parseLicenseResponse(resp);
  }

  /** get current chain tip */
  async getTip(): Promise<ChainTip> {
    const resp = await this.grpcCall('GetTip', new Uint8Array(0));
    return this.parseTip(resp);
  }

  /**
   * lightwalletd `GetLightdInfo`. zidecar serves this via its CompactTxStreamer
   * compatibility service (`cash.z.wallet.sdk.rpc.CompactTxStreamer`), NOT the
   * native `zidecar.v1.Zidecar` service, so we hit the lwd path here.
   * `consensusBranchId` is field 6 (hex string, no 0x prefix); the turnstile
   * builder fails closed unless it is the real NU6.3 branch id (0x37a5165b).
   */
  async getLightdInfo(): Promise<LightdInfo> {
    const resp = await this.grpcCallService(
      'cash.z.wallet.sdk.rpc.CompactTxStreamer',
      'GetLightdInfo',
      new Uint8Array(0),
    );
    return decodeLightdInfo(resp);
  }

  /**
   * FlyClient proof of this node's chain (zidecar --flyclient), the raw
   * FlyClientProofResponse that `verify_flyclient` reads. lambda and tail stay
   * 0 (the defaults the verifier assumes); burial (field 3) asks for the note
   * tree roots `burial` blocks under the tip. It names nothing about the wallet.
   */
  async getFlyClientProof(burial: number, maxBytes: number): Promise<FlyProof> {
    let serverTime: number | undefined;
    const proof = await this.grpcCallService(
      'zidecar.v1.Zidecar',
      'GetFlyClientProof',
      new Uint8Array([0x18, ...this.varint(burial)]),
      {
        maxBytes,
        // the node's own clock, to tell a stale tip from a wrong local clock
        onHeaders: h => {
          const t = Date.parse(h.get('date') ?? '');
          serverTime = Number.isFinite(t) ? t : undefined;
        },
      },
    );
    return { proof, serverTime };
  }

  /** get current pro ring for anonymous membership proofs */
  async getProRing(): Promise<ProRing> {
    const resp = await this.grpcCall('GetProRing', new Uint8Array(0));
    return this.parseProRing(resp);
  }

  /** get compact blocks for scanning */
  async getCompactBlocks(startHeight: number, endHeight: number): Promise<CompactBlock[]> {
    // encode BlockRange proto
    const parts: number[] = [];
    if (startHeight > 0) {
      parts.push(0x08);
      parts.push(...this.varint(startHeight));
    }
    if (endHeight > 0) {
      parts.push(0x10);
      parts.push(...this.varint(endHeight));
    }

    // streaming RPC - need raw response with gRPC frames intact
    const resp = await this.grpcCallStream('GetCompactBlocks', new Uint8Array(parts));
    return this.parseBlockStream(resp);
  }

  /** lightwalletd GetSubtreeRoots, served on zidecar's CompactTxStreamer surface */
  async getSubtreeRoots(pool: SubtreePool, startIndex: number): Promise<SubtreeRoot[]> {
    const resp = await this.grpcCallStream(
      'GetSubtreeRoots',
      encodeSubtreeRootsArg(pool, startIndex),
      undefined,
      'cash.z.wallet.sdk.rpc.CompactTxStreamer',
    );
    return parseSubtreeRootStream(resp);
  }

  /**
   * Get mempool as compact blocks (height=0, hash=txid) for trial decryption.
   * Accepts an optional AbortSignal so a long-running poll can be cancelled
   * mid-fetch when the wallet asks for sync shutdown.
   */
  async getMempoolStream(signal?: AbortSignal): Promise<CompactBlock[]> {
    const resp = await this.grpcCallStream('GetMempoolStream', new Uint8Array(0), signal);
    return this.parseBlockStream(resp);
  }

  /** send raw transaction */
  async sendTransaction(
    txData: Uint8Array,
  ): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }> {
    // encode RawTransaction proto
    const parts: number[] = [0x0a, ...this.lengthDelimited(txData)];
    const resp = await this.grpcCall('SendTransaction', new Uint8Array(parts));

    // parse SendResponse { txid=1; int32 errorCode=2; errorMessage=3 }
    let txid = new Uint8Array(0);
    let errorCode = 0;
    let errorMessage = '';
    eachField(resp, (field, wire, val) => {
      if (wire === WIRE_VARINT && field === 2) {
        errorCode = int32(val as bigint);
      } else if (wire === WIRE_LEN && field === 1) {
        txid = (val as Uint8Array).slice();
      } else if (wire === WIRE_LEN && field === 3) {
        errorMessage = new TextDecoder().decode(val as Uint8Array);
      }
    });

    return alreadySent(errorMessage)
      ? { txid: new Uint8Array(0), errorCode: 0, errorMessage: '' }
      : { txid, errorCode, errorMessage };
  }

  /** request an ed25519 anchor attestation from zidecar's verifier (SignAnchor).
   *  signs SHA256("zcash-anchor-v1" || vk || anchor || height_LE || mainnet).
   *  available=false when the server has no signing key configured. */
  async signAnchor(
    anchor: Uint8Array,
    height: number,
    mainnet: boolean,
  ): Promise<{ available: boolean; signatureHex: string; verifierKeyHex: string }> {
    const parts: number[] = [];
    parts.push(0x0a, ...this.lengthDelimited(anchor)); // field 1 bytes anchor
    if (height > 0) {
      parts.push(0x10, ...this.varint(height));
    } // field 2 uint32 height
    if (mainnet) {
      parts.push(0x18, 0x01);
    } // field 3 bool mainnet (omit when false)
    const resp = await this.grpcCall('SignAnchor', new Uint8Array(parts));

    // SignAnchorResponse { signature=1; verifier_key=2; available=3 }
    const toHex = (u: Uint8Array) => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');
    let signatureHex = '';
    let verifierKeyHex = '';
    let available = false;
    eachField(resp, (field, wire, val) => {
      if (wire === WIRE_LEN && field === 1) {
        signatureHex = toHex(val as Uint8Array);
      } else if (wire === WIRE_LEN && field === 2) {
        verifierKeyHex = toHex(val as Uint8Array);
      } else if (wire === WIRE_VARINT && field === 3) {
        available = val !== 0n;
      }
    });
    return { available, signatureHex, verifierKeyHex };
  }

  /** build binary format for parallel scanning */
  static buildBinaryActions(actions: CompactAction[]): Uint8Array {
    const actionSize = 32 + 32 + 32 + 52; // nullifier + cmx + epk + ciphertext
    const buf = new Uint8Array(4 + actions.length * actionSize);
    const view = new DataView(buf.buffer);
    view.setUint32(0, actions.length, true);

    let off = 4;
    for (const a of actions) {
      if (a.nullifier.length === 32) {
        buf.set(a.nullifier, off);
      }
      off += 32;
      if (a.cmx.length === 32) {
        buf.set(a.cmx, off);
      }
      off += 32;
      if (a.ephemeralKey.length === 32) {
        buf.set(a.ephemeralKey, off);
      }
      off += 32;
      if (a.ciphertext.length >= 52) {
        buf.set(a.ciphertext.subarray(0, 52), off);
      }
      off += 52;
    }

    return buf;
  }

  // --- private helpers ---

  private async grpcCall(method: string, msg: Uint8Array): Promise<Uint8Array> {
    return this.grpcCallService('zidecar.v1.Zidecar', method, msg);
  }

  /**
   * Unary grpc-web call against an arbitrary service on this endpoint. Most
   * RPCs use the native `zidecar.v1.Zidecar` service (via `grpcCall`), but the
   * lightwalletd-compat surface (e.g. GetLightdInfo) lives under
   * `cash.z.wallet.sdk.rpc.CompactTxStreamer` on the same host.
   */
  private async grpcCallService(
    service: string,
    method: string,
    msg: Uint8Array,
    {
      maxBytes = Infinity,
      onHeaders,
    }: {
      /** refuse a response body past this size, before it is all read */
      maxBytes?: number;
      onHeaders?: (headers: Headers) => void;
    } = {},
  ): Promise<Uint8Array> {
    const { resp, body } = await grpcWebFetch(this.serverUrl, service, method, msg, {
      maxBytes,
      onHeaders,
      signal: this.signal,
    });
    return grpcWebUnaryMessage(resp, body, method, this.serverUrl);
  }

  /** raw gRPC-web call for server-streaming RPCs - returns full response with frame headers */
  private async grpcCallStream(
    method: string,
    msg: Uint8Array,
    signal?: AbortSignal,
    service = 'zidecar.v1.Zidecar',
  ): Promise<Uint8Array> {
    const { body } = await grpcWebFetch(this.serverUrl, service, method, msg, {
      signal:
        signal && this.signal ? AbortSignal.any([signal, this.signal]) : (signal ?? this.signal),
    });
    return body;
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

  private parseTip(buf: Uint8Array): ChainTip {
    let height = 0;
    let hash = new Uint8Array(0);
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT && field === 1) {
        height = Number(val as bigint);
      } else if (wire === WIRE_LEN && field === 2) {
        hash = (val as Uint8Array).slice();
      }
    });
    return { height, hash };
  }

  private parseBlockStream(buf: Uint8Array): CompactBlock[] {
    const blocks: CompactBlock[] = [];
    let pos = 0;

    while (pos < buf.length) {
      if (pos + 5 > buf.length) {
        break;
      }
      if (buf[pos] === 0x80) {
        break;
      } // trailer

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

  private parseBlock(buf: Uint8Array): CompactBlock {
    const block: CompactBlock = { height: 0, hash: new Uint8Array(0), actions: [] };
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT) {
        if (field === 1) {
          block.height = Number(val as bigint);
        }
        return;
      }
      if (wire !== WIRE_LEN) {
        return;
      }
      const data = val as Uint8Array;
      if (field === 2) {
        block.hash = data;
      } else if (field === 3) {
        block.actions.push(this.parseAction(data));
      } else if (field === 4) {
        block.actionsRoot = data.slice();
      } else if (field === 5) {
        // ironwood_actions - same wire shape as orchard actions. Without
        // this the wallet downloads its own ironwood notes and discards
        // them, showing zero after a turnstile migration.
        (block.ironwoodActions ??= []).push(this.parseAction(data));
      }
    });
    return block;
  }

  private parseAction(buf: Uint8Array): CompactAction {
    const a: CompactAction = {
      cmx: new Uint8Array(0),
      ephemeralKey: new Uint8Array(0),
      ciphertext: new Uint8Array(0),
      nullifier: new Uint8Array(0),
      txid: new Uint8Array(0),
    };
    eachField(buf, (field, wire, val) => {
      if (wire !== WIRE_LEN) {
        return;
      }
      const data = val as Uint8Array;
      if (field === 1) {
        a.cmx = data;
      } else if (field === 2) {
        a.ephemeralKey = data;
      } else if (field === 3) {
        a.ciphertext = data;
      } else if (field === 4) {
        a.nullifier = data;
      } else if (field === 5) {
        a.txid = data;
      }
    });
    return a;
  }

  /** get tree state at a specific height (orchard + ironwood frontiers for witness building) */
  async getTreeState(
    height: number,
  ): Promise<{ height: number; orchardTree: string; ironwoodTree?: string; time: number }> {
    // encode BlockId proto: field 1 = height (varint)
    const parts: number[] = [0x08, ...this.varint(height)];
    const resp = await this.grpcCall('GetTreeState', new Uint8Array(parts));
    return this.parseTreeState(resp);
  }

  /** get block time (unix seconds) from compact block */
  async getBlockTime(height: number): Promise<number> {
    const parts: number[] = [0x08, ...this.varint(height)];
    const resp = await this.grpcCall('GetBlock', new Uint8Array(parts));
    // CompactBlock proto: field 5 = time (varint); the first one wins
    let time: number | undefined;
    eachField(resp, (field, wire, val) => {
      if (wire === WIRE_VARINT && field === 5 && time === undefined) {
        time = Number(val as bigint);
      }
    });
    return time ?? 0;
  }

  /** get transparent address UTXOs */
  async getAddressUtxos(address: string, startHeight = 0, maxEntries = 0): Promise<Utxo[]> {
    // GetAddressUtxosArg { addresses=1 (one, never several), startHeight=2, maxEntries=3 }
    const parts: number[] = [0x0a, ...this.lengthDelimited(new TextEncoder().encode(address))];
    if (startHeight > 0) {
      parts.push(0x10, ...this.varint(startHeight));
    }
    if (maxEntries > 0) {
      parts.push(0x18, ...this.varint(maxEntries));
    }
    const resp = await this.grpcCall('GetAddressUtxos', new Uint8Array(parts));
    return this.parseUtxoList(resp);
  }

  /** transparent transaction ids for one address */
  async getTaddressTxids(address: string, startHeight = 0): Promise<Uint8Array[]> {
    // TransparentAddressFilter, the same shape as GetAddressUtxosArg
    const parts: number[] = [0x0a, ...this.lengthDelimited(new TextEncoder().encode(address))];
    if (startHeight > 0) {
      parts.push(0x10, ...this.varint(startHeight));
    }
    const resp = await this.grpcCall('GetTaddressTxids', new Uint8Array(parts));
    return this.parseTxidList(resp);
  }

  /** get raw transaction by hash (reveals txid to server - use getBlockTransactions for privacy) */
  async getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }> {
    // encode TxFilter proto: field 1 = hash (bytes)
    const parts: number[] = [0x0a, ...this.lengthDelimited(txid)];
    const resp = await this.grpcCall('GetTransaction', new Uint8Array(parts));
    return this.parseRawTransaction(resp);
  }

  /**
   * privacy-preserving transaction fetch
   * fetches all transactions at a block height - server doesn't learn which tx we care about
   */
  async getBlockTransactions(height: number): Promise<{
    height: number;
    hash: Uint8Array;
    txs: { data: Uint8Array; height: number }[];
  }> {
    // encode BlockId proto: field 1 = height (uint32)
    const parts: number[] = [0x08, ...this.varint(height)];
    const resp = await this.grpcCall('GetBlockTransactions', new Uint8Array(parts));
    return this.parseBlockTransactions(resp);
  }

  private parseBlockTransactions(buf: Uint8Array): {
    height: number;
    hash: Uint8Array;
    txs: { data: Uint8Array; height: number }[];
  } {
    let height = 0;
    let hash = new Uint8Array(0);
    const txs: { data: Uint8Array; height: number }[] = [];
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT && field === 1) {
        height = Number(val as bigint);
      } else if (wire === WIRE_LEN && field === 2) {
        hash = (val as Uint8Array).slice();
      } else if (wire === WIRE_LEN && field === 3) {
        txs.push(this.parseRawTransaction(val as Uint8Array));
      }
    });
    return { height, hash, txs };
  }

  private parseRawTransaction(buf: Uint8Array): { data: Uint8Array; height: number } {
    let data = new Uint8Array(0);
    let height = 0;
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_LEN && field === 1) {
        data = (val as Uint8Array).slice();
      } else if (wire === WIRE_VARINT && field === 2) {
        height = Number(val as bigint);
      }
    });
    return { data, height };
  }

  private parseUtxoList(buf: Uint8Array): Utxo[] {
    // GetAddressUtxosReplyList: field 1 repeated GetAddressUtxosReply
    const utxos: Utxo[] = [];
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_LEN && field === 1) {
        utxos.push(this.parseUtxo(val as Uint8Array));
      }
    });
    return utxos;
  }

  private parseUtxo(buf: Uint8Array): Utxo {
    // GetAddressUtxosReply:
    //   field 1: string address
    //   field 2: bytes txid
    //   field 3: int32 output_index (index)
    //   field 4: bytes script
    //   field 5: uint64 value_zat (kept as bigint)
    //   field 6: uint64 height
    const utxo: Utxo = {
      address: '',
      txid: new Uint8Array(0),
      outputIndex: 0,
      script: new Uint8Array(0),
      valueZat: 0n,
      height: 0,
    };
    const decoder = new TextDecoder();
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT) {
        const v = val as bigint;
        if (field === 3) {
          utxo.outputIndex = Number(v);
        } else if (field === 5) {
          utxo.valueZat = v;
        } else if (field === 6) {
          utxo.height = Number(v);
        }
      } else if (wire === WIRE_LEN) {
        const data = val as Uint8Array;
        if (field === 1) {
          utxo.address = decoder.decode(data);
        } else if (field === 2) {
          utxo.txid = data;
        } else if (field === 4) {
          utxo.script = data;
        }
      }
    });
    return utxo;
  }

  private parseTreeState(buf: Uint8Array): {
    height: number;
    orchardTree: string;
    ironwoodTree?: string;
    time: number;
  } {
    // TreeState proto (zidecar.proto):
    //   field 1: uint32 height (varint)
    //   field 2: bytes hash (length-delimited)
    //   field 3: uint64 time (varint)
    //   field 4: string sapling_tree (length-delimited)
    //   field 5: string orchard_tree (length-delimited)
    //   field 6: string ironwood_tree (length-delimited, NU6.3; absent pre-upgrade)
    // zidecar numbers ironwood_tree 6 (lightwalletd numbers it 7 - keep distinct).
    let height = 0;
    let time = 0;
    let orchardTree = '';
    let ironwoodTree = '';
    const decoder = new TextDecoder();
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT) {
        if (field === 1) {
          height = Number(val as bigint);
        } else if (field === 3) {
          time = Number(val as bigint);
        }
      } else if (wire === WIRE_LEN) {
        if (field === 5) {
          orchardTree = decoder.decode(val as Uint8Array);
        } else if (field === 6) {
          // zidecar.v1 TreeState.ironwood_tree = 6. This read field 7, which
          // is the LIGHTWALLETD TreeState number - so against zidecar it never
          // matched and every ironwood send failed with "server has no
          // ironwood tree state", despite the server returning it correctly.
          ironwoodTree = decoder.decode(val as Uint8Array);
        }
      }
    });

    // omit ironwoodTree entirely when the server didn't send it so callers
    // can feature-detect with a simple truthiness check
    return ironwoodTree
      ? { height, orchardTree, ironwoodTree, time }
      : { height, orchardTree, time };
  }

  private parseTxidList(buf: Uint8Array): Uint8Array[] {
    // TxidList: field 1 repeated bytes txids
    const txids: Uint8Array[] = [];
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_LEN && field === 1) {
        txids.push(val as Uint8Array);
      }
    });
    return txids;
  }

  private parseProRing(buf: Uint8Array): ProRing {
    const ringKeys: string[] = [];
    let commitment = new Uint8Array(0);
    let epoch = '';
    let context = '';
    let ringSize = 0;
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT) {
        if (field === 5) {
          ringSize = Number(val as bigint);
        }
      } else if (wire === WIRE_LEN) {
        const data = val as Uint8Array;
        if (field === 1) {
          // repeated bytes ring_keys - each is a 32-byte pubkey
          ringKeys.push(Array.from(data, b => b.toString(16).padStart(2, '0')).join(''));
        } else if (field === 2) {
          commitment = data.slice();
        } else if (field === 3) {
          epoch = new TextDecoder().decode(data);
        } else if (field === 4) {
          context = new TextDecoder().decode(data);
        }
      }
    });
    return { ringKeys, commitment, epoch, context, ringSize };
  }

  private parseLicenseResponse(buf: Uint8Array): LicenseInfo {
    let zid = '';
    let plan = 'free';
    let expires = 0;
    let signature = '';
    let totalPaidZat = 0;
    eachField(buf, (field, wire, val) => {
      if (wire === WIRE_VARINT) {
        if (field === 3) {
          expires = Number(val as bigint);
        } else if (field === 5) {
          totalPaidZat = Number(val as bigint);
        }
      } else if (wire === WIRE_LEN) {
        const data = val as Uint8Array;
        if (field === 1) {
          zid = new TextDecoder().decode(data);
        } else if (field === 2) {
          plan = new TextDecoder().decode(data);
        } else if (field === 4) {
          signature = Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
        }
      }
    });
    return { zid, plan, expires, signature, totalPaidZat };
  }
}
