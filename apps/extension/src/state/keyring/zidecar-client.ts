/**
 * zidecar grpc-web client
 *
 * connects to zidecar server for trustless zcash sync
 * uses raw protobuf encoding (no grpc-web library needed)
 */

export interface SyncStatus {
  currentHeight: number;
  currentEpoch: number;
  blocksInEpoch: number;
  completeEpochs: number;
  gigaproofStatus: number;
  lastGigaproofHeight: number;
  blocksUntilReady: number;
}

export interface CompactBlock {
  height: number;
  hash: Uint8Array;
  actions: CompactAction[];
  actionsRoot?: Uint8Array;
  /**
   * NU6.3 ironwood pool actions (same compact-action shape as orchard),
   * decoded from `zidecar.v1 CompactBlock.ironwood_actions = 5`. Absent on
   * servers predating ironwood; the sync worker consumes it defensively
   * (`?? []`), so an old server simply yields no ironwood notes.
   */
  ironwoodActions?: CompactAction[];
}

export interface CompactAction {
  cmx: Uint8Array;
  ephemeralKey: Uint8Array;
  ciphertext: Uint8Array;
  nullifier: Uint8Array;
  txid: Uint8Array;
}

export interface ChainTip {
  height: number;
  hash: Uint8Array;
}

export interface Utxo {
  address: string;
  txid: Uint8Array;
  outputIndex: number;
  script: Uint8Array;
  valueZat: bigint;
  height: number;
}

export interface CommitmentProofData {
  cmx: Uint8Array;
  treeRoot: Uint8Array;
  pathProofRaw: Uint8Array;
  valueHash: Uint8Array;
  exists: boolean;
}

export interface NullifierProofData {
  nullifier: Uint8Array;
  nullifierRoot: Uint8Array;
  isSpent: boolean;
  pathProofRaw: Uint8Array;
  valueHash: Uint8Array;
}

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

  /** optional callback that returns extra headers (ring VRF proof, etc.) */
  static extraHeaders: (() => Record<string, string>) | null = null;

  constructor(serverUrl: string) {
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
  async getLightdInfo(): Promise<{
    consensusBranchId: string;
    chainName: string;
    blockHeight: number;
    saplingActivationHeight: number;
  }> {
    const resp = await this.grpcCallService(
      'cash.z.wallet.sdk.rpc.CompactTxStreamer',
      'GetLightdInfo',
      new Uint8Array(0),
    );
    return this.parseLightdInfo(resp);
  }

  /** get current pro ring for anonymous membership proofs */
  async getProRing(): Promise<ProRing> {
    const resp = await this.grpcCall('GetProRing', new Uint8Array(0));
    return this.parseProRing(resp);
  }

  /** get sync status (chain height, epoch info, gigaproof status) */
  async getSyncStatus(): Promise<SyncStatus> {
    const resp = await this.grpcCall('GetSyncStatus', new Uint8Array(0));
    return this.parseSyncStatus(resp);
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

    // streaming RPC — need raw response with gRPC frames intact
    const resp = await this.grpcCallStream('GetCompactBlocks', new Uint8Array(parts));
    return this.parseBlockStream(resp);
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

    // parse SendResponse
    let txid = new Uint8Array(0);
    let errorCode = 0;
    let errorMessage = '';
    let pos = 0;

    while (pos < resp.length) {
      const tag = resp[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 2) {
          errorCode = v;
        }
      } else if (wire === 2) {
        let len = 0,
          s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        const data = resp.slice(pos, pos + len);
        if (field === 1) {
          txid = data;
        } else if (field === 3) {
          errorMessage = new TextDecoder().decode(data);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { txid, errorCode, errorMessage };
  }

  /** get header proof (ligerito epoch + tip) */
  async getHeaderProof(): Promise<{
    proofBytes: Uint8Array;
    fromHeight: number;
    toHeight: number;
  }> {
    // ProofRequest: field 1 = from_height (0), field 2 = to_height (0 = current tip)
    const resp = await this.grpcCall('GetHeaderProof', new Uint8Array(0));
    return this.parseHeaderProof(resp);
  }

  /** get NOMT commitment proofs for a batch of cmxs */
  async getCommitmentProofs(
    cmxs: Uint8Array[],
    positions: number[],
    height: number,
  ): Promise<{ proofs: CommitmentProofData[]; treeRoot: Uint8Array }> {
    const parts: number[] = [];
    for (const cmx of cmxs) {
      parts.push(0x0a, ...this.lengthDelimited(cmx)); // field 1 repeated bytes
    }
    for (const pos of positions) {
      parts.push(0x10, ...this.varint(pos)); // field 2 repeated uint64
    }
    if (height > 0) {
      parts.push(0x18, ...this.varint(height)); // field 3 uint32
    }
    const resp = await this.grpcCall('GetCommitmentProofs', new Uint8Array(parts));
    return this.parseCommitmentProofsResponse(resp);
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

    let pos = 0;
    const toHex = (u: Uint8Array) => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');
    let signatureHex = '';
    let verifierKeyHex = '';
    let available = false;
    while (pos < resp.length) {
      const tag = resp[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (wire === 2) {
        let len = 0,
          s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        const data = resp.subarray(pos, pos + len);
        pos += len;
        if (field === 1) {
          signatureHex = toHex(data);
        } else if (field === 2) {
          verifierKeyHex = toHex(data);
        }
      } else if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 3) {
          available = v !== 0;
        }
      } else {
        break;
      }
    }
    return { available, signatureHex, verifierKeyHex };
  }

  /** get NOMT nullifier proofs for a batch of nullifiers */
  async getNullifierProofs(
    nullifiers: Uint8Array[],
    height: number,
  ): Promise<{
    proofs: NullifierProofData[];
    nullifierRoot: Uint8Array;
    /** highest block the sapling/orchard index covers; 0 when unknown */
    syncedHeight: number;
    /** highest block the ironwood index covers; 0 when unknown */
    ironwoodSyncedHeight: number;
  }> {
    const parts: number[] = [];
    for (const nf of nullifiers) {
      parts.push(0x0a, ...this.lengthDelimited(nf)); // field 1 repeated bytes
    }
    if (height > 0) {
      parts.push(0x10, ...this.varint(height)); // field 2 uint32
    }
    const resp = await this.grpcCall('GetNullifierProofs', new Uint8Array(parts));
    return this.parseNullifierProofsResponse(resp);
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
  ): Promise<Uint8Array> {
    const path = `${this.serverUrl}/${service}/${method}`;

    // wrap message in grpc-web frame
    const body = new Uint8Array(5 + msg.length);
    body[0] = 0; // not compressed
    body[1] = (msg.length >> 24) & 0xff;
    body[2] = (msg.length >> 16) & 0xff;
    body[3] = (msg.length >> 8) & 0xff;
    body[4] = msg.length & 0xff;
    body.set(msg, 5);

    const headers: Record<string, string> = {
      'Content-Type': 'application/grpc-web+proto',
      Accept: 'application/grpc-web+proto',
      'x-grpc-web': '1',
      ...(ZidecarClient.extraHeaders?.() ?? {}),
    };

    const resp = await fetch(path, { method: 'POST', headers, body });

    if (!resp.ok) {
      throw new Error(`gRPC ${method}: HTTP ${resp.status}`);
    }

    const buf = new Uint8Array(await resp.arrayBuffer());

    if (buf.length < 5) {
      // check HTTP headers for grpc-status (trailer-only response)
      const grpcStatus = resp.headers.get('grpc-status');
      const grpcMessage = resp.headers.get('grpc-message');
      if (grpcStatus && grpcStatus !== '0') {
        throw new Error(
          `gRPC ${method}: ${decodeURIComponent(grpcMessage ?? `status ${grpcStatus}`)}`,
        );
      }
      throw new Error(`gRPC ${method}: empty response from ${this.serverUrl}`);
    }

    const flags = buf[0]!;

    // if first frame is a trailer frame (flags & 0x80), parse grpc-status from it
    if (flags & 0x80) {
      const trailerLen = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
      const trailerText = new TextDecoder().decode(buf.subarray(5, 5 + trailerLen));
      const statusMatch = /grpc-status:\s*(\d+)/.exec(trailerText);
      const messageMatch = /grpc-message:\s*(.+)/.exec(trailerText);
      const status = statusMatch?.[1] ?? '0';
      if (status !== '0') {
        const msg = messageMatch?.[1]?.trim();
        throw new Error(`gRPC ${method}: ${decodeURIComponent(msg ?? `status ${status}`)}`);
      }
      // status 0 but no data frame — treat as empty success
      return new Uint8Array(0);
    }

    // extract first data frame (unary RPCs only)
    const len = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
    return buf.subarray(5, 5 + len);
  }

  /** raw gRPC-web call for server-streaming RPCs — returns full response with frame headers */
  private async grpcCallStream(
    method: string,
    msg: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const path = `${this.serverUrl}/zidecar.v1.Zidecar/${method}`;

    const body = new Uint8Array(5 + msg.length);
    body[0] = 0;
    body[1] = (msg.length >> 24) & 0xff;
    body[2] = (msg.length >> 16) & 0xff;
    body[3] = (msg.length >> 8) & 0xff;
    body[4] = msg.length & 0xff;
    body.set(msg, 5);

    const headers: Record<string, string> = {
      'Content-Type': 'application/grpc-web+proto',
      Accept: 'application/grpc-web+proto',
      'x-grpc-web': '1',
      ...(ZidecarClient.extraHeaders?.() ?? {}),
    };

    const resp = await fetch(path, { method: 'POST', headers, body, signal });

    if (!resp.ok) {
      throw new Error(`gRPC HTTP ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
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
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 1) {
          height = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        if (field === 2) {
          hash = buf.slice(pos, pos + len);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { height, hash };
  }

  private parseSyncStatus(buf: Uint8Array): SyncStatus {
    const r: SyncStatus = {
      currentHeight: 0,
      currentEpoch: 0,
      blocksInEpoch: 0,
      completeEpochs: 0,
      gigaproofStatus: 0,
      lastGigaproofHeight: 0,
      blocksUntilReady: 0,
    };
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      if ((tag & 0x7) !== 0) {
        break;
      }

      let v = 0,
        s = 0;
      while (pos < buf.length) {
        const b = buf[pos++]!;
        v |= (b & 0x7f) << s;
        if (!(b & 0x80)) {
          break;
        }
        s += 7;
      }

      if (field === 1) {
        r.currentHeight = v;
      } else if (field === 2) {
        r.currentEpoch = v;
      } else if (field === 3) {
        r.blocksInEpoch = v;
      } else if (field === 4) {
        r.completeEpochs = v;
      } else if (field === 5) {
        r.gigaproofStatus = v;
      } else if (field === 6) {
        // proto: `uint32 blocks_until_ready = 6;` (0 when the proof is ready)
        r.blocksUntilReady = v;
      } else if (field === 7) {
        // proto: `uint32 last_epoch_proof_height = 7;`
        r.lastGigaproofHeight = v;
      }
    }

    return r;
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
      // `pos += len` walks BACKWARDS — an unbounded loop that pushes an object
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
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 1) {
          block.height = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 2) {
          block.hash = data;
        } else if (field === 3) {
          block.actions.push(this.parseAction(data));
        } else if (field === 4) {
          block.actionsRoot = buf.slice(pos, pos + len);
        } else if (field === 5) {
          // ironwood_actions — same wire shape as orchard actions. Without
          // this the wallet downloads its own ironwood notes and discards
          // them, showing zero after a turnstile migration.
          (block.ironwoodActions ??= []).push(this.parseAction(data));
        }
        pos += len;
      } else {
        break;
      }
    }

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
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
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
        pos += len;
      } else {
        break;
      }
    }

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
    // CompactBlock proto: field 5 = time (varint)
    let pos = 0;
    while (pos < resp.length) {
      const tag = resp[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;
      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 5) {
          return v;
        }
      } else if (wire === 2) {
        let len = 0,
          s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        pos += len;
      } else {
        break;
      }
    }
    return 0;
  }

  /** get transparent address UTXOs */
  async getAddressUtxos(addresses: string[], startHeight = 0, maxEntries = 0): Promise<Utxo[]> {
    // encode GetAddressUtxosArg proto
    const parts: number[] = [];
    const encoder = new TextEncoder();
    for (const addr of addresses) {
      const addrBytes = encoder.encode(addr);
      // field 1: repeated string addresses
      parts.push(0x0a, ...this.lengthDelimited(addrBytes));
    }
    if (startHeight > 0) {
      // field 2: uint32 startHeight
      parts.push(0x10, ...this.varint(startHeight));
    }
    if (maxEntries > 0) {
      // field 3: uint32 maxEntries
      parts.push(0x18, ...this.varint(maxEntries));
    }

    const resp = await this.grpcCall('GetAddressUtxos', new Uint8Array(parts));
    return this.parseUtxoList(resp);
  }

  /** get transparent transaction IDs for addresses */
  async getTaddressTxids(addresses: string[], startHeight = 0): Promise<Uint8Array[]> {
    // encode TransparentAddressFilter proto (same as GetAddressUtxos)
    const parts: number[] = [];
    const encoder = new TextEncoder();
    for (const addr of addresses) {
      const addrBytes = encoder.encode(addr);
      parts.push(0x0a, ...this.lengthDelimited(addrBytes));
    }
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
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 1) {
          height = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.slice(pos, pos + len);
        if (field === 2) {
          hash = data;
        } else if (field === 3) {
          txs.push(this.parseRawTransaction(data));
        }
        pos += len;
      } else {
        break;
      }
    }

    return { height, hash, txs };
  }

  private parseRawTransaction(buf: Uint8Array): { data: Uint8Array; height: number } {
    let data = new Uint8Array(0);
    let height = 0;
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 2) {
          height = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        if (field === 1) {
          data = buf.slice(pos, pos + len);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { data, height };
  }

  private parseUtxoList(buf: Uint8Array): Utxo[] {
    // GetAddressUtxosReplyList: field 1 repeated GetAddressUtxosReply
    const utxos: Utxo[] = [];
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        if (field === 1) {
          utxos.push(this.parseUtxo(buf.subarray(pos, pos + len)));
        }
        pos += len;
      } else if (wire === 0) {
        // skip varint
        while (pos < buf.length && buf[pos++]! & 0x80) {
          /* skip */
        }
      } else {
        break;
      }
    }

    return utxos;
  }

  private parseUtxo(buf: Uint8Array): Utxo {
    // GetAddressUtxosReply:
    //   field 1: string address
    //   field 2: bytes txid
    //   field 3: int32 output_index (index)
    //   field 4: bytes script
    //   field 5: uint64 value_zat
    //   field 6: uint64 height
    const utxo: Utxo = {
      address: '',
      txid: new Uint8Array(0),
      outputIndex: 0,
      script: new Uint8Array(0),
      valueZat: 0n,
      height: 0,
    };
    let pos = 0;
    const decoder = new TextDecoder();

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        // varint — need to handle uint64 for valueZat
        let v = 0n;
        let s = 0n;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= BigInt(b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7n;
        }
        if (field === 3) {
          utxo.outputIndex = Number(v);
        } else if (field === 5) {
          utxo.valueZat = v;
        } else if (field === 6) {
          utxo.height = Number(v);
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 1) {
          utxo.address = decoder.decode(data);
        } else if (field === 2) {
          utxo.txid = data;
        } else if (field === 4) {
          utxo.script = data;
        }
        pos += len;
      } else {
        break;
      }
    }

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
    let pos = 0;
    const decoder = new TextDecoder();

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 1) {
          height = v;
        }
        if (field === 3) {
          time = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 5) {
          orchardTree = decoder.decode(data);
        } else if (field === 6) {
          // zidecar.v1 TreeState.ironwood_tree = 6. This read field 7, which
          // is the LIGHTWALLETD TreeState number — so against zidecar it never
          // matched and every ironwood send failed with "server has no
          // ironwood tree state", despite the server returning it correctly.
          ironwoodTree = decoder.decode(data);
        }
        pos += len;
      } else {
        break;
      }
    }

    // omit ironwoodTree entirely when the server didn't send it so callers
    // can feature-detect with a simple truthiness check
    return ironwoodTree
      ? { height, orchardTree, ironwoodTree, time }
      : { height, orchardTree, time };
  }

  private parseHeaderProof(buf: Uint8Array): {
    proofBytes: Uint8Array;
    fromHeight: number;
    toHeight: number;
  } {
    let proofBytes = new Uint8Array(0);
    let fromHeight = 0;
    let toHeight = 0;
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 2) {
          fromHeight = v;
        } else if (field === 3) {
          toHeight = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        if (field === 1) {
          proofBytes = buf.slice(pos, pos + len);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { proofBytes, fromHeight, toHeight };
  }

  private parseCommitmentProof(buf: Uint8Array): CommitmentProofData {
    const proof: CommitmentProofData = {
      cmx: new Uint8Array(0),
      treeRoot: new Uint8Array(0),
      pathProofRaw: new Uint8Array(0),
      valueHash: new Uint8Array(0),
      exists: false,
    };
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 7) {
          proof.exists = v !== 0;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.slice(pos, pos + len);
        if (field === 1) {
          proof.cmx = data;
        } else if (field === 3) {
          proof.treeRoot = data;
        } else if (field === 8) {
          proof.pathProofRaw = data;
        } else if (field === 9) {
          proof.valueHash = data;
        }
        pos += len;
      } else {
        break;
      }
    }

    return proof;
  }

  private parseCommitmentProofsResponse(buf: Uint8Array): {
    proofs: CommitmentProofData[];
    treeRoot: Uint8Array;
  } {
    const proofs: CommitmentProofData[] = [];
    let treeRoot = new Uint8Array(0);
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 1) {
          proofs.push(this.parseCommitmentProof(data));
        } else if (field === 2) {
          treeRoot = buf.slice(pos, pos + len);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { proofs, treeRoot };
  }

  private parseNullifierProof(buf: Uint8Array): NullifierProofData {
    const proof: NullifierProofData = {
      nullifier: new Uint8Array(0),
      nullifierRoot: new Uint8Array(0),
      isSpent: false,
      pathProofRaw: new Uint8Array(0),
      valueHash: new Uint8Array(0),
    };
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 6) {
          proof.isSpent = v !== 0;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.slice(pos, pos + len);
        if (field === 1) {
          proof.nullifier = data;
        } else if (field === 2) {
          proof.nullifierRoot = data;
        } else if (field === 7) {
          proof.pathProofRaw = data;
        } else if (field === 8) {
          proof.valueHash = data;
        }
        pos += len;
      } else {
        break;
      }
    }

    return proof;
  }

  private parseNullifierProofsResponse(buf: Uint8Array): {
    proofs: NullifierProofData[];
    nullifierRoot: Uint8Array;
    syncedHeight: number;
    ironwoodSyncedHeight: number;
  } {
    const proofs: NullifierProofData[] = [];
    let nullifierRoot = new Uint8Array(0);
    let syncedHeight = 0;
    let ironwoodSyncedHeight = 0;
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        // varint. This branch used to `break`, which meant any scalar field
        // silently truncated the parse — the sync-height fields below sit
        // after the length-delimited ones on the wire.
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 3) {
          syncedHeight = v;
        } else if (field === 4) {
          ironwoodSyncedHeight = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 1) {
          proofs.push(this.parseNullifierProof(data));
        } else if (field === 2) {
          nullifierRoot = buf.slice(pos, pos + len);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { proofs, nullifierRoot, syncedHeight, ironwoodSyncedHeight };
  }

  private parseTxidList(buf: Uint8Array): Uint8Array[] {
    // TxidList: field 1 repeated bytes txids
    const txids: Uint8Array[] = [];
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        if (field === 1) {
          txids.push(buf.subarray(pos, pos + len));
        }
        pos += len;
      } else if (wire === 0) {
        while (pos < buf.length && buf[pos++]! & 0x80) {
          /* skip varint */
        }
      } else {
        break;
      }
    }

    return txids;
  }

  private parseProRing(buf: Uint8Array): ProRing {
    const ringKeys: string[] = [];
    let commitment = new Uint8Array(0);
    let epoch = '';
    let context = '';
    let ringSize = 0;
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 5) {
          ringSize = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 1) {
          // repeated bytes ring_keys - each is a 32-byte pubkey
          ringKeys.push(Array.from(data, b => b.toString(16).padStart(2, '0')).join(''));
        } else if (field === 2) {
          commitment = buf.slice(pos, pos + len);
        } else if (field === 3) {
          epoch = new TextDecoder().decode(data);
        } else if (field === 4) {
          context = new TextDecoder().decode(data);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { ringKeys, commitment, epoch, context, ringSize };
  }

  private parseLightdInfo(buf: Uint8Array): {
    consensusBranchId: string;
    chainName: string;
    blockHeight: number;
    saplingActivationHeight: number;
  } {
    // LightdInfo (lightwalletd service.proto):
    //   field 4:  string chainName
    //   field 5:  uint64 saplingActivationHeight (varint)
    //   field 6:  string consensusBranchId (hex, no 0x)
    //   field 8:  uint64 blockHeight (varint)
    let consensusBranchId = '';
    let chainName = '';
    let blockHeight = 0;
    let saplingActivationHeight = 0;
    let pos = 0;
    const decoder = new TextDecoder();

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 5) {
          saplingActivationHeight = v;
        } else if (field === 8) {
          blockHeight = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        const data = buf.subarray(pos, pos + len);
        if (field === 4) {
          chainName = decoder.decode(data);
        } else if (field === 6) {
          consensusBranchId = decoder.decode(data);
        }
        pos += len;
      } else {
        break;
      }
    }

    return { consensusBranchId, chainName, blockHeight, saplingActivationHeight };
  }

  private parseLicenseResponse(buf: Uint8Array): LicenseInfo {
    let zid = '';
    let plan = 'free';
    let expires = 0;
    let signature = '';
    let totalPaidZat = 0;
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 0) {
        let v = 0,
          s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (field === 3) {
          expires = v;
        }
        if (field === 5) {
          totalPaidZat = v;
        }
      } else if (wire === 2) {
        // Unsigned + shift-bounded. `len |= (b & 0x7f) << s` overflows to a
        // NEGATIVE int32 at s=28, after which `pos += len` walks backwards and
        // the parser loops re-reading the same bytes forever. Multiply instead
        // of shift, and refuse a varint longer than 5 bytes.
        let len = 0,
          s = 0,
          lenBytes = 0;
        while (pos < buf.length && lenBytes < 5) {
          const b = buf[pos++]!;
          len += (b & 0x7f) * Math.pow(2, s);
          lenBytes++;
          if (!(b & 0x80)) {
            break;
          }
          s += 7;
        }
        if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) {
          break;
        }
        if (field === 1) {
          zid = new TextDecoder().decode(buf.subarray(pos, pos + len));
        } else if (field === 2) {
          plan = new TextDecoder().decode(buf.subarray(pos, pos + len));
        } else if (field === 4) {
          signature = Array.from(buf.subarray(pos, pos + len), b =>
            b.toString(16).padStart(2, '0'),
          ).join('');
        }
        pos += len;
      } else {
        break;
      }
    }

    return { zid, plan, expires, signature, totalPaidZat };
  }
}
