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
}

export interface CompactAction {
  cmx: Uint8Array;
  ephemeralKey: Uint8Array;
  ciphertext: Uint8Array;
  nullifier: Uint8Array;
}

export interface ChainTip {
  height: number;
  hash: Uint8Array;
}

export class ZidecarClient {
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  /** get current chain tip */
  async getTip(): Promise<ChainTip> {
    const resp = await this.grpcCall('GetTip', new Uint8Array(0));
    return this.parseTip(resp);
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

    const resp = await this.grpcCall('GetCompactBlocks', new Uint8Array(parts));
    return this.parseBlockStream(resp);
  }

  /** send raw transaction */
  async sendTransaction(txData: Uint8Array): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }> {
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
        let v = 0, s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        if (field === 2) errorCode = v;
      } else if (wire === 2) {
        let len = 0, s = 0;
        while (pos < resp.length) {
          const b = resp[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        const data = resp.slice(pos, pos + len);
        if (field === 1) txid = data;
        else if (field === 3) errorMessage = new TextDecoder().decode(data);
        pos += len;
      } else break;
    }

    return { txid, errorCode, errorMessage };
  }

  /** build binary format for parallel scanning */
  static buildBinaryActions(actions: CompactAction[]): Uint8Array {
    const actionSize = 32 + 32 + 32 + 52; // nullifier + cmx + epk + ciphertext
    const buf = new Uint8Array(4 + actions.length * actionSize);
    const view = new DataView(buf.buffer);
    view.setUint32(0, actions.length, true);

    let off = 4;
    for (const a of actions) {
      if (a.nullifier.length === 32) buf.set(a.nullifier, off);
      off += 32;
      if (a.cmx.length === 32) buf.set(a.cmx, off);
      off += 32;
      if (a.ephemeralKey.length === 32) buf.set(a.ephemeralKey, off);
      off += 32;
      if (a.ciphertext.length >= 52) buf.set(a.ciphertext.slice(0, 52), off);
      off += 52;
    }

    return buf;
  }

  // --- private helpers ---

  private async grpcCall(method: string, msg: Uint8Array): Promise<Uint8Array> {
    const path = `${this.serverUrl}/zidecar.v1.Zidecar/${method}`;

    // wrap message in grpc-web frame
    const body = new Uint8Array(5 + msg.length);
    body[0] = 0; // not compressed
    body[1] = (msg.length >> 24) & 0xff;
    body[2] = (msg.length >> 16) & 0xff;
    body[3] = (msg.length >> 8) & 0xff;
    body[4] = msg.length & 0xff;
    body.set(msg, 5);

    const resp = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'Accept': 'application/grpc-web+proto',
        'x-grpc-web': '1',
      },
      body,
    });

    if (!resp.ok) throw new Error(`gRPC HTTP ${resp.status}`);

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 5) throw new Error('empty grpc response');

    // extract first frame
    const len = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
    return buf.slice(5, 5 + len);
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
        let v = 0, s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        if (field === 1) height = v;
      } else if (wire === 2) {
        let len = 0, s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        if (field === 2) hash = buf.slice(pos, pos + len);
        pos += len;
      } else break;
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
      if ((tag & 0x7) !== 0) break;

      let v = 0, s = 0;
      while (pos < buf.length) {
        const b = buf[pos++]!;
        v |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }

      if (field === 1) r.currentHeight = v;
      else if (field === 2) r.currentEpoch = v;
      else if (field === 3) r.blocksInEpoch = v;
      else if (field === 4) r.completeEpochs = v;
      else if (field === 5) r.gigaproofStatus = v;
      else if (field === 6) r.lastGigaproofHeight = v;
      else if (field === 7) r.blocksUntilReady = v;
    }

    return r;
  }

  private parseBlockStream(buf: Uint8Array): CompactBlock[] {
    const blocks: CompactBlock[] = [];
    let pos = 0;

    while (pos < buf.length) {
      if (pos + 5 > buf.length) break;
      if (buf[pos] === 0x80) break; // trailer

      const len = (buf[pos + 1]! << 24) | (buf[pos + 2]! << 16) | (buf[pos + 3]! << 8) | buf[pos + 4]!;
      pos += 5;
      if (pos + len > buf.length) break;

      blocks.push(this.parseBlock(buf.slice(pos, pos + len)));
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
        let v = 0, s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        if (field === 1) block.height = v;
      } else if (wire === 2) {
        let len = 0, s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        const data = buf.slice(pos, pos + len);
        if (field === 2) block.hash = data;
        else if (field === 3) block.actions.push(this.parseAction(data));
        pos += len;
      } else break;
    }

    return block;
  }

  private parseAction(buf: Uint8Array): CompactAction {
    const a: CompactAction = {
      cmx: new Uint8Array(0),
      ephemeralKey: new Uint8Array(0),
      ciphertext: new Uint8Array(0),
      nullifier: new Uint8Array(0),
    };
    let pos = 0;

    while (pos < buf.length) {
      const tag = buf[pos++]!;
      const field = tag >> 3;
      const wire = tag & 0x7;

      if (wire === 2) {
        let len = 0, s = 0;
        while (pos < buf.length) {
          const b = buf[pos++]!;
          len |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        const data = buf.slice(pos, pos + len);
        if (field === 1) a.cmx = data;
        else if (field === 2) a.ephemeralKey = data;
        else if (field === 3) a.ciphertext = data;
        else if (field === 4) a.nullifier = data;
        pos += len;
      } else break;
    }

    return a;
  }
}
