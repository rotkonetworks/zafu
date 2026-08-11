/**
 * The shielded cold-send TAIL, as ONE function - `signAndBroadcast`.
 *
 * Every cold signer (Ledger WebHID, self-custody FROST, zigner QR, airgap FROST)
 * is the same `ExternalSigner` (see external-signer.ts): unsigned PCZT in, a
 * `SignResult` out. What differs is only the CLOSING move, and it dispatches on
 * the `SignResult` variant - the DELIVERY FORM - not on pool:
 *
 *   - `spendAuthSigs` -> INJECT. The host kept the unsigned PCZT; the signer
 *     returned raw spend-auth signatures; `complete_orchard_pczt` injects them
 *     (re-verifying each against its action's randomized vk in the worker) and
 *     broadcasts. The only inject role is orchard, so this variant is orchard by
 *     construction - Ledger / FROST / airgap.
 *
 *   - `signedPczt` -> EXTRACT. The signer returned an already-signed PCZT (device
 *     signed it, or contributions were merged in host-side via
 *     `apply_signature_contributions`); the worker extracts the tx and broadcasts
 *     (`completeSendTxPcztInWorker`). Pool-agnostic - orchard AND ironwood - the
 *     pool falls out of the PCZT. This is the zigner shape.
 *
 * There is no `pool` parameter and no ironwood throw: ironwood simply cannot be
 * completed from `spendAuthSigs` (no ironwood inject role exists), so an ironwood
 * cold send MUST arrive as `signedPczt`. That is a different variant, not an
 * illegal state - the type carries the invariant.
 */

import {
  completeOrchardPcztInWorker,
  completeSendTxPcztInWorker,
} from '../state/keyring/network-worker';
import type { ExternalSigner } from './external-signer';

/**
 * The unsigned shielded PCZT a cold-send build produces. A structural subset of
 * the worker's SendTxPcztUnsignedResult - only what the signer + tail consume.
 * No `pool`: the completion is chosen by the `SignResult` variant, not here.
 */
export interface UnsignedColdSend {
  readonly pcztHex: string;
  /** Real-spend action indices still needing a spend-auth signature (the
   *  IoFinalizer already self-signed the dummies). Consumed only by the inject
   *  path; a `signedPczt` result already carries its signatures. */
  readonly spendIndices: number[];
  /** Ties the completion back to the build so the worker can mark the spent
   *  inputs and record the send. */
  readonly coldSendId?: string;
}

export interface BroadcastResult {
  readonly txid: string;
}

/** Optional UI hook - the send component owns its step/progress state; the
 *  orchestrator only signals the boundary between "signed" and "broadcasting"
 *  so those transitions stay in the component. */
export interface ColdSendHooks {
  readonly onSigned?: () => void;
}

export interface ColdSendDeps {
  readonly walletId: string;
  readonly zidecarUrl: string;
  readonly mainnet: boolean;
}

/**
 * Sign an unsigned shielded PCZT with any `ExternalSigner` and complete +
 * broadcast it. One function; the completion is chosen by the `SignResult`
 * variant the signer returns (see the module doc).
 */
export async function signAndBroadcast(
  signer: ExternalSigner,
  unsigned: UnsignedColdSend,
  deps: ColdSendDeps,
  hooks: ColdSendHooks = {},
): Promise<BroadcastResult> {
  const result = await signer({
    pcztHex: unsigned.pcztHex,
    spendIndices: unsigned.spendIndices,
    mainnet: deps.mainnet,
  });

  hooks.onSigned?.();

  switch (result.kind) {
    case 'spendAuthSigs':
      // Raw spend-auth sigs -> the orchard inject role. `spendIndices` comes
      // from the signer's result (it may reorder/subset relative to the build),
      // and complete_orchard_pczt is the authority on the sig<->action pairing.
      return completeOrchardPcztInWorker(
        deps.walletId,
        deps.zidecarUrl,
        unsigned.pcztHex,
        result.spendAuthSigs,
        result.spendIndices,
        unsigned.coldSendId,
      );
    case 'signedPczt':
      // Already-signed PCZT -> pool-agnostic extract + broadcast.
      return completeSendTxPcztInWorker(
        'zcash',
        deps.walletId,
        deps.zidecarUrl,
        result.pcztHex,
        unsigned.coldSendId,
      );
  }
}
