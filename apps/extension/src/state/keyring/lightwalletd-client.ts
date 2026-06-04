// Standard CompactTxStreamer over native gRPC (public lightwalletd rejects
// grpc-web with 415). Body framing matches grpc-web so fetch reads it, but the
// gRPC status sits in unreadable HTTP/2 trailers — so HTTP 200 + data = success.
// Trusted backend: no zidecar proofs, so the worker skips verification.

import type { ChainTip, CompactAction, CompactBlock, Utxo } from './zidecar-client';
import type { ZcashClient } from './zcash-backend';

const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer';

const UNSUPPORTED = (m: string) => new Error(`${m} not available on a public lightwalletd endpoint`);

export class LightwalletdClient implements ZcashClient {
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  async getTip(): Promise<ChainTip> {
    // GetLatestBlock(ChainSpec{}) → BlockID { uint64 height=1; bytes hash=2 }
    const resp = await this.grpcCall('GetLatestBlock', new Uint8Array(0));
    let height = 0;
    let hash: Uint8Array = new Uint8Array(0);
    this.eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 1) height = Number(val as bigint);
      else if (wire === 2 && field === 2) hash = val as Uint8Array;
    });
    return { height, hash };
  }

  async getTreeState(height: number): Promise<{ height: number; orchardTree: string; time: number }> {
    // GetTreeState(BlockID{height=1}) → TreeState { height=2; time=4; orchardTree=6 }
    const req = new Uint8Array([0x08, ...this.varint(height)]);
    const resp = await this.grpcCall('GetTreeState', req);
    let h = 0;
    let time = 0;
    let orchardTree = '';
    const decoder = new TextDecoder();
    this.eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 2) h = Number(val as bigint);
      else if (wire === 0 && field === 4) time = Number(val as bigint);
      else if (wire === 2 && field === 6) orchardTree = decoder.decode(val as Uint8Array);
    });
    return { height: h, orchardTree, time };
  }

  async getCompactBlocks(startHeight: number, endHeight: number): Promise<CompactBlock[]> {
    // GetBlockRange(BlockRange{ start=1:BlockID{height=1}, end=2:BlockID{height=1} })
    const startId = [0x08, ...this.varint(startHeight)];
    const endId = [0x08, ...this.varint(endHeight)];
    const req = new Uint8Array([
      0x0a, ...this.lengthDelimited(new Uint8Array(startId)),
      0x12, ...this.lengthDelimited(new Uint8Array(endId)),
    ]);
    const resp = await this.grpcCallStream('GetBlockRange', req);
    return this.parseBlockStream(resp);
  }

  /** lightwalletd streams full txs here, not trial-decryptable compact blocks — no mempool preview. */
  async getMempoolStream(): Promise<CompactBlock[]> {
    return [];
  }

  async getAddressUtxos(addresses: string[], startHeight = 0, maxEntries = 0): Promise<Utxo[]> {
    // GetAddressUtxos(GetAddressUtxosArg{ addresses=1, startHeight=2, maxEntries=3 })
    const parts: number[] = [];
    const encoder = new TextEncoder();
    for (const addr of addresses) parts.push(0x0a, ...this.lengthDelimited(encoder.encode(addr)));
    if (startHeight > 0) parts.push(0x10, ...this.varint(startHeight));
    if (maxEntries > 0) parts.push(0x18, ...this.varint(maxEntries));
    const resp = await this.grpcCall('GetAddressUtxos', new Uint8Array(parts));

    // GetAddressUtxosReplyList { addressUtxos=1 repeated GetAddressUtxosReply }
    const utxos: Utxo[] = [];
    this.eachField(resp, (field, wire, val) => {
      if (wire === 2 && field === 1) utxos.push(this.parseUtxo(val as Uint8Array));
    });
    return utxos;
  }

  async getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }> {
    // GetTransaction(TxFilter{ hash=1 }) → RawTransaction { data=1; height=2 }
    const req = new Uint8Array([0x0a, ...this.lengthDelimited(txid)]);
    const resp = await this.grpcCall('GetTransaction', req);
    return this.parseRawTransaction(resp);
  }

  async getBlockTime(height: number): Promise<number> {
    // GetBlock(BlockID{height=1}) → CompactBlock { time=5 }
    const req = new Uint8Array([0x08, ...this.varint(height)]);
    const resp = await this.grpcCall('GetBlock', req);
    let time = 0;
    this.eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 5) time = Number(val as bigint);
    });
    return time;
  }

  async sendTransaction(txData: Uint8Array): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }> {
    // SendTransaction(RawTransaction{data=1}) → SendResponse{errorCode=1; errorMessage=2}; no txid, ok when errorCode===0
    const req = new Uint8Array([0x0a, ...this.lengthDelimited(txData)]);
    const resp = await this.grpcCall('SendTransaction', req);
    let errorCode = 0;
    let errorMessage = '';
    const decoder = new TextDecoder();
    this.eachField(resp, (field, wire, val) => {
      if (wire === 0 && field === 1) errorCode = Number(val as bigint);
      else if (wire === 2 && field === 2) errorMessage = decoder.decode(val as Uint8Array);
    });
    return { txid: new Uint8Array(0), errorCode, errorMessage };
  }

  // Not exposed by lightwalletd — return empty so opt-in features degrade quietly instead of erroring.

  async getTaddressTxids(): Promise<Uint8Array[]> {
    return [];
  }

  async getBlockTransactions(height: number): Promise<{ height: number; hash: Uint8Array; txs: Array<{ data: Uint8Array; height: number }> }> {
    return { height, hash: new Uint8Array(0), txs: [] };
  }

  async getHeaderProof(): Promise<{ proofBytes: Uint8Array; fromHeight: number; toHeight: number }> {
    throw UNSUPPORTED('header proof');
  }

  async getCommitmentProofs(): Promise<{ proofs: never[]; treeRoot: Uint8Array }> {
    throw UNSUPPORTED('commitment proofs');
  }

  async getNullifierProofs(): Promise<{ proofs: never[]; nullifierRoot: Uint8Array }> {
    throw UNSUPPORTED('nullifier proofs');
  }

  async getSyncStatus(): Promise<never> {
    throw UNSUPPORTED('sync status');
  }

  // ── protobuf / grpc-web helpers ──

  private async grpcCall(method: string, msg: Uint8Array): Promise<Uint8Array> {
    const resp = await this.fetchGrpc(method, msg);
    const buf = new Uint8Array(await resp.arrayBuffer());

    if (buf.length < 5) {
      const status = resp.headers.get('grpc-status');
      if (status && status !== '0') {
        throw new Error(`gRPC ${method}: ${decodeURIComponent(resp.headers.get('grpc-message') ?? `status ${status}`)}`);
      }
      throw new Error(`gRPC ${method}: empty response from ${this.serverUrl}`);
    }

    const flags = buf[0]!;
    if (flags & 0x80) {
      const trailerLen = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
      const trailer = new TextDecoder().decode(buf.subarray(5, 5 + trailerLen));
      const status = trailer.match(/grpc-status:\s*(\d+)/)?.[1] ?? '0';
      if (status !== '0') {
        const m = trailer.match(/grpc-message:\s*(.+)/)?.[1]?.trim();
        throw new Error(`gRPC ${method}: ${decodeURIComponent(m ?? `status ${status}`)}`);
      }
      return new Uint8Array(0);
    }

    const len = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
    return buf.subarray(5, 5 + len);
  }

  private async grpcCallStream(method: string, msg: Uint8Array): Promise<Uint8Array> {
    const resp = await this.fetchGrpc(method, msg);
    return new Uint8Array(await resp.arrayBuffer());
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
      // native gRPC content-type — public lightwalletd rejects grpc-web (415)
      headers: { 'Content-Type': 'application/grpc' },
      body,
    });
    if (!resp.ok) throw new Error(`gRPC ${method}: HTTP ${resp.status}`);
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

  /** iterate top-level protobuf fields; `val` is bigint for varints, Uint8Array for length-delimited. */
  private eachField(buf: Uint8Array, fn: (field: number, wire: number, val: bigint | Uint8Array) => void): void {
    let pos = 0;
    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (wire === 0) {
        let v = 0n, s = 0n;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= BigInt(b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7n;
        }
        fn(field, wire, v);
      } else if (wire === 2) {
        let len = 0, s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        fn(field, wire, buf.subarray(pos, pos + len));
        pos += len;
      } else if (wire === 5) {
        pos += 4;
      } else if (wire === 1) {
        pos += 8;
      } else break;
    }
  }

  private parseBlockStream(buf: Uint8Array): CompactBlock[] {
    const blocks: CompactBlock[] = [];
    let pos = 0;
    while (pos < buf.length) {
      if (pos + 5 > buf.length) break;
      if (buf[pos]! & 0x80) break; // trailer frame
      const len = (buf[pos + 1]! << 24) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 8) | buf[pos + 4]!;
      pos += 5;
      if (pos + len > buf.length) break;
      blocks.push(this.parseBlock(buf.subarray(pos, pos + len)));
      pos += len;
    }
    return blocks;
  }

  /** CompactBlock { height=2; hash=3; vtx=7 repeated CompactTx } */
  private parseBlock(buf: Uint8Array): CompactBlock {
    const block: CompactBlock = { height: 0, hash: new Uint8Array(0), actions: [] };
    this.eachField(buf, (field, wire, val) => {
      if (wire === 0 && field === 2) block.height = Number(val as bigint);
      else if (wire === 2 && field === 3) block.hash = val as Uint8Array;
      else if (wire === 2 && field === 7) {
        for (const a of this.parseCompactTx(val as Uint8Array)) block.actions.push(a);
      }
    });
    return block;
  }

  /** CompactTx { hash=2 (txid); actions=6 repeated CompactOrchardAction } */
  private parseCompactTx(buf: Uint8Array): CompactAction[] {
    let txid: Uint8Array = new Uint8Array(0);
    const rawActions: Uint8Array[] = [];
    this.eachField(buf, (field, wire, val) => {
      if (wire === 2 && field === 2) txid = val as Uint8Array;
      else if (wire === 2 && field === 6) rawActions.push(val as Uint8Array);
    });
    return rawActions.map(raw => {
      const a = this.parseAction(raw);
      a.txid = txid;
      return a;
    });
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
    this.eachField(buf, (field, wire, val) => {
      if (wire !== 2) return;
      const data = val as Uint8Array;
      if (field === 1) a.nullifier = data;
      else if (field === 2) a.cmx = data;
      else if (field === 3) a.ephemeralKey = data;
      else if (field === 4) a.ciphertext = data;
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
    this.eachField(buf, (field, wire, val) => {
      if (wire === 0) {
        const v = val as bigint;
        if (field === 2) utxo.outputIndex = Number(v);
        else if (field === 4) utxo.valueZat = v;
        else if (field === 5) utxo.height = Number(v);
      } else if (wire === 2) {
        const data = val as Uint8Array;
        if (field === 1) utxo.txid = data;
        else if (field === 3) utxo.script = data;
        else if (field === 6) utxo.address = decoder.decode(data);
      }
    });
    return utxo;
  }

  /** RawTransaction { data=1; height=2 } */
  private parseRawTransaction(buf: Uint8Array): { data: Uint8Array; height: number } {
    let data: Uint8Array = new Uint8Array(0);
    let height = 0;
    this.eachField(buf, (field, wire, val) => {
      if (wire === 2 && field === 1) data = val as Uint8Array;
      else if (wire === 0 && field === 2) height = Number(val as bigint);
    });
    return { data, height };
  }
}
