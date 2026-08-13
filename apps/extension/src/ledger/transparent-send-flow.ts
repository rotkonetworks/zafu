/**
 * End-to-end orchestration for a Ledger transparent (t->t) send, kept OUT of the
 * release-critical send screen (`src/routes/popup/send/zcash-send.tsx`). That
 * screen would call `ledgerTransparentSendFlow` from its Ledger branch once the
 * feature flips on; until then this is the single reviewed place the four steps
 * live together.
 *
 * HOW IT HOOKS INTO zcash-send.tsx (documented, not wired - that file is
 * off-limits here):
 *
 *   1. The send screen already resolves `serverUrl`, the tip `blockHeight`,
 *      `mainnet`, the recipient and the amount for every zcash send.
 *   2. For a `coldSignerType === 'ledger'` wallet whose spend is transparent, it
 *      would additionally know the Ledger t-address(es) to spend from and a
 *      change address+path (both from the connected device / wallet record).
 *   3. It calls `ledgerTransparentSendFlow(req, deps)` passing
 *      `getTransparentUtxosInWorker` and `broadcastRawTxInWorker` from
 *      `state/keyring/network-worker` as `deps`. Those run in the worker; the
 *      DEVICE SIGNING inside this flow runs in the page context (WebHID), which
 *      is why the flow must be invoked from the side panel / tab, never the
 *      torn-down popup - the same constraint the connect screen documents.
 *
 * Dependencies are INJECTED rather than imported so the ledger module keeps its
 * "no runtime coupling to the rest of the extension" property (only a type-only
 * import of the UTXO shape). The send screen supplies the concrete functions.
 */

import type { TransparentUtxoInfo } from '../state/keyring/network-worker';
import { ledgerTransparentSend } from './transparent';
import {
  planLedgerTransparentSend,
  selectTransparentUtxos,
  type LedgerTransparentChange,
} from './transparent-send-plan';

export interface LedgerTransparentSendFlowDeps {
  /** fetch spendable UTXOs (with prev-tx bytes) for the given addresses. Wire
   *  `getTransparentUtxosInWorker`. */
  readonly fetchUtxos: (serverUrl: string, addresses: string[]) => Promise<TransparentUtxoInfo[]>;
  /** submit a fully-signed tx hex. Wire `broadcastRawTxInWorker`. */
  readonly broadcast: (serverUrl: string, txHex: string) => Promise<{ txid: string }>;
}

export interface LedgerTransparentSendRequest {
  readonly serverUrl: string;
  /** the Ledger transparent address(es) to spend from. */
  readonly fromAddresses: readonly string[];
  readonly recipientAddress: string;
  readonly amountZat: bigint;
  readonly feeZat: bigint;
  /** change back to the wallet. Required unless amount + fee consumes the whole
   *  selected input set exactly. */
  readonly change: LedgerTransparentChange;
  readonly accountIndex: number;
  readonly mainnet: boolean;
  /** chain tip height. Expiry is deliberately left 0 (see
   *  APP_COMMITS_TO_EXPIRY_HEIGHT); do not pass a non-zero expiry to a released
   *  app. */
  readonly blockHeight: number;
}

export interface LedgerTransparentSendOutcome {
  readonly txid: string;
  readonly signedTxHex: string;
}

/**
 * Fetch -> select -> assemble -> device-sign -> broadcast.
 *
 * Fails closed at each seam: `planLedgerTransparentSend` refuses under-funded or
 * unroutable-change requests, and `ledgerTransparentSend` gates the app version
 * / consensus branch id / signer-kit compatibility BEFORE touching the money
 * path. On any released app today the device-sign step throws with a specific
 * reason (NU6.3 branch id unknown to the app; signer-kit SIGN apdu shaped
 * wrong) rather than emitting a doomed transaction - see ./capabilities.ts.
 */
export async function ledgerTransparentSendFlow(
  req: LedgerTransparentSendRequest,
  deps: LedgerTransparentSendFlowDeps,
): Promise<LedgerTransparentSendOutcome> {
  const available = await deps.fetchUtxos(req.serverUrl, [...req.fromAddresses]);
  if (available.length === 0) {
    throw new Error('ledger send: no spendable transparent utxos at the source address');
  }

  const { selected } = selectTransparentUtxos(available, req.amountZat + req.feeZat);

  const { params } = await planLedgerTransparentSend({
    utxos: selected,
    recipientAddress: req.recipientAddress,
    amountZat: req.amountZat,
    feeZat: req.feeZat,
    change: req.change,
    accountIndex: req.accountIndex,
    mainnet: req.mainnet,
    blockHeight: req.blockHeight,
  });

  // Device builds + signs the whole transparent tx and returns the signed hex.
  const signedTxHex = await ledgerTransparentSend(params);

  const { txid } = await deps.broadcast(req.serverUrl, signedTxHex);
  return { txid, signedTxHex };
}
