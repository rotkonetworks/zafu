// Public API for zafu's Ledger hardware-wallet integration.
//
// Flag-gated scaffolding (HARDWARE_WALLET_ENABLED). Ships when LedgerHQ's
// app-zcash >= 3.8.0 releases (adds getShieldedAddress + UFVK export). The
// @ledgerhq packages are dynamically imported inside the transport/signer
// modules so they stay out of the main bundle; their TYPES are used statically
// and are checked against the installed packages (there is deliberately no
// hand-written .d.ts shim - one previously shadowed the real types and hid
// several wrong field names).
//
// NOT FUNCTIONAL YET: the shielded path needs `describe_pczt_for_ledger` in
// @repo/zcash-wasm, which does not exist. Every shielded sign attempt throws.

import { getZcashSigner } from './transport';
import { runDeviceAction } from './da-util';
import { pcztHexToLedgerPcztTransaction } from './pczt-translate';
import { bytesToHex } from './hex';

export { isLedgerSupported, connectLedger } from './transport';
export {
  ledgerCapabilities,
  versionAtLeast,
  transparentSigningSupport,
  branchForHeight,
  MIN_SHIELDED_APP_VERSION,
  CONSENSUS_BRANCH_ID,
  NETWORK_UPGRADE_ACTIVATION,
  type LedgerCapabilities,
  type TransparentSigningSupport,
  type NetworkUpgradeName,
} from './capabilities';
export {
  getLedgerTransparentAddress,
  ledgerTransparentSend,
  buildOutputScriptHex,
  expiryHeightBytes,
  transparentPath,
  DEVICE_MAX_OUTPUTS,
  DEVICE_MAX_SCRIPT_SIZE,
  type LedgerUtxo,
  type LedgerOutput,
  type LedgerTransparentSendParams,
} from './transparent';
export {
  zcashV5PrevTxToLedgerWire,
  prevTxHexToLedgerWire,
  type LedgerPrevTx,
  type LedgerPrevTxOutput,
} from './prevtx';
export type { LedgerConnection } from './transport';
export { getLedgerAccount } from './signer';
export type { LedgerAccount } from './signer';
export {
  pcztHexToLedgerPcztTransaction,
  pcztHexToLedgerIronwoodTransaction,
  ledgerDescribeToPcztTransaction,
} from './pczt-translate';
export type {
  LedgerPcztDescribe,
  LedgerPcztGlobalJson,
  LedgerPcztOrchardBundleJson,
  LedgerPcztOrchardActionJson,
} from './pczt-translate';

export interface SignPcztWithLedgerOptions {
  readonly spendIndices: number[];
  readonly mainnet: boolean;
}

export interface LedgerSignResult {
  readonly orchardSigs: string[];
  readonly spendIndices: number[];
}

/**
 * Sign a zafu Orchard-V5 PCZT on a connected Ledger over WebHID.
 *
 * zafu's IoFinalizer already computed the proof + binding signature at build
 * time, so the device only produces the per-action Orchard spendAuthSigs. We
 * return them hex-encoded and ALIGNED to `spendIndices`, ready for injection
 * via zafu's complete_orchard_pczt (completeOrchardPcztInWorker).
 */
export async function signPcztWithLedger(
  sessionId: string,
  pcztHex: string,
  { spendIndices, mainnet }: SignPcztWithLedgerOptions,
): Promise<LedgerSignResult> {
  const { signer } = await getZcashSigner(sessionId);

  const transaction = await pcztHexToLedgerPcztTransaction(pcztHex, { mainnet });
  const result = await runDeviceAction(signer.signPcztTransaction(transaction));

  // The device returns one spendAuthSig per SIGNED action, in ascending
  // action-index order, with dummy spends OMITTED (they are self-signed
  // host-side by the PCZT IoFinalizer) - see SignPcztTransactionResult in
  // @ledgerhq/device-signer-kit-zcash. So `result.orchard` is positionally
  // aligned with `spendIndices` (also ascending real-spend action indices);
  // it is NOT indexable by action index. Indexing by action index silently
  // pairs a signature with the wrong action whenever any dummy precedes a real
  // spend, which produces an invalid transaction (or, worse, a valid one
  // authorising a different action).
  if (result.orchard.length !== spendIndices.length) {
    throw new Error(
      `ledger returned ${result.orchard.length} orchard signatures for ` +
        `${spendIndices.length} spends - refusing to guess the pairing`,
    );
  }
  const orchardSigs = result.orchard.map(action => bytesToHex(action.spendAuthSig));

  return { orchardSigs, spendIndices };
}
