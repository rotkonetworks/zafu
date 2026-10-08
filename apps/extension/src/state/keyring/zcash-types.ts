// The chain data every zcash backend returns (zidecar and lightwalletd
// alike), decoded from their wire messages.

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
