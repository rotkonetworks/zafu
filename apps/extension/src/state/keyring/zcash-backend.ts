// zidecar (trustless) vs generic lightwalletd (trusted) endpoint selection.

import type {
  ChainTip,
  CompactBlock,
  CommitmentProofData,
  NullifierProofData,
  SyncStatus,
  Utxo,
} from './zidecar-client';

export type ZcashBackend = 'zidecar' | 'lightwalletd';

/** Construct the right sync client for a known backend (UI-thread helper). */
export async function zcashClientFor(serverUrl: string, backend: ZcashBackend): Promise<ZcashClient> {
  // eager: also bundled into the worker, which has no `document` for chunk loading
  if (backend === 'lightwalletd') {
    const { LightwalletdClient } = await import(/* webpackMode: "eager" */ './lightwalletd-client');
    return new LightwalletdClient(serverUrl);
  }
  const { ZidecarClient } = await import(/* webpackMode: "eager" */ './zidecar-client');
  return new ZidecarClient(serverUrl);
}

/** Method surface the worker drives a backend through; ZidecarClient is a structural superset. */
export interface ZcashClient {
  getTip(): Promise<ChainTip>;
  getTreeState(height: number): Promise<{ height: number; orchardTree: string; time: number }>;
  getCompactBlocks(startHeight: number, endHeight: number): Promise<CompactBlock[]>;
  getMempoolStream(): Promise<CompactBlock[]>;
  getAddressUtxos(addresses: string[], startHeight?: number, maxEntries?: number): Promise<Utxo[]>;
  getTaddressTxids(addresses: string[], startHeight?: number): Promise<Uint8Array[]>;
  getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }>;
  getBlockTransactions(height: number): Promise<{ height: number; hash: Uint8Array; txs: Array<{ data: Uint8Array; height: number }> }>;
  getBlockTime(height: number): Promise<number>;
  sendTransaction(txData: Uint8Array): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }>;
  // trustless-only (zidecar)
  getHeaderProof(): Promise<{ proofBytes: Uint8Array; fromHeight: number; toHeight: number }>;
  getCommitmentProofs(cmxs: Uint8Array[], positions: number[], height: number): Promise<{ proofs: CommitmentProofData[]; treeRoot: Uint8Array }>;
  getNullifierProofs(nullifiers: Uint8Array[], height: number): Promise<{ proofs: NullifierProofData[]; nullifierRoot: Uint8Array }>;
  getSyncStatus(): Promise<SyncStatus>;
}

/** Probe a zidecar-only RPC: valid response → 'zidecar', 404/501/unimplemented → 'lightwalletd'; network errors rethrow. */
export async function detectZcashBackend(serverUrl: string, timeoutMs = 8000): Promise<ZcashBackend> {
  const base = serverUrl.replace(/\/$/, '');
  const path = `${base}/zidecar.v1.Zidecar/GetSyncStatus`;
  const body = new Uint8Array(5); // empty grpc-web frame


  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'Accept': 'application/grpc-web+proto',
        'x-grpc-web': '1',
      },
      body,
      signal: ctrl.signal,
    });

    if (!resp.ok) return 'lightwalletd'; // unknown service path → not a zidecar

    // gRPC unimplemented surfaces as a non-zero status in headers or a trailer-only frame
    const headerStatus = resp.headers.get('grpc-status');
    if (headerStatus && headerStatus !== '0') return 'lightwalletd';

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length >= 5 && (buf[0]! & 0x80)) {
      const trailer = new TextDecoder().decode(buf.subarray(5));
      const m = trailer.match(/grpc-status:\s*(\d+)/);
      if (m && m[1] !== '0') return 'lightwalletd';
    }

    return 'zidecar';
  } finally {
    clearTimeout(timer);
  }
}
