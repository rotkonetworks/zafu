/**
 * End-to-end Ledger transparent (t->t) send via the LEGACY Bitcoin-app path
 * (hw-app-btc). Mirrors transparent-send-flow.ts step-for-step but swaps the
 * blocked DMK signer (ledgerTransparentSend) for the hw-app-btc signer
 * (hw-btc-signer.ts), which signs transparent Zcash on mainnet TODAY.
 *
 * Erwan's UTXO selection + plan assembly are reused verbatim - only the signing
 * transport differs, and the DMK-shaped plan adapts 1:1 to the hw-app-btc input
 * shape (raw prev-tx bytes, vout and per-input path carry over; outputs pack
 * into the same outputScriptHex layout).
 *
 * DEVICE-TEST GATE + surface constraint: WebHID signing runs in the page
 * context, so this must be invoked from a tab / side panel, never the toolbar
 * popup (which is torn down on blur). And nothing here is proven until a real
 * t->t send is confirmed on a physical Ledger - see hw-btc-signer.ts.
 */

import type { TransparentUtxoInfo } from '../state/keyring/network-worker';
import { buildOutputScriptHex } from './transparent';
import {
  planLedgerTransparentSend,
  selectTransparentUtxos,
  type LedgerTransparentChange,
} from './transparent-send-plan';
import {
  signZcashTransparentWithLedger,
  type LedgerBtcTransport,
  type HwBtcUtxo,
} from './hw-btc-signer';

export interface LedgerBtcSendFlowDeps {
  /** fetch spendable UTXOs (with prev-tx bytes) for the given addresses. Wire
   *  `getTransparentUtxosInWorker`. */
  readonly fetchUtxos: (serverUrl: string, addresses: string[]) => Promise<TransparentUtxoInfo[]>;
  /** submit a fully-signed tx hex. Wire `broadcastRawTxInWorker`. */
  readonly broadcast: (serverUrl: string, txHex: string) => Promise<{ txid: string }>;
}

export interface LedgerBtcSendRequest {
  readonly serverUrl: string;
  readonly fromAddresses: readonly string[];
  readonly recipientAddress: string;
  readonly amountZat: bigint;
  readonly feeZat: bigint;
  readonly change: LedgerTransparentChange;
  readonly accountIndex: number;
  readonly mainnet: boolean;
  readonly blockHeight: number;
}

export interface LedgerBtcSendOutcome {
  readonly txid: string;
  readonly signedTxHex: string;
}

/** Fetch -> select -> assemble (Erwan) -> hw-app-btc device-sign -> broadcast. */
export async function ledgerTransparentSendFlowBtc(
  transport: LedgerBtcTransport,
  req: LedgerBtcSendRequest,
  deps: LedgerBtcSendFlowDeps,
): Promise<LedgerBtcSendOutcome> {
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

  const utxos: HwBtcUtxo[] = params.utxos.map(u => ({
    prevTxHex: u.prevTxHex,
    vout: u.vout,
    path: u.path,
  }));

  const signedTxHex = await signZcashTransparentWithLedger(transport, {
    utxos,
    outputScriptHex: buildOutputScriptHex(params.outputs),
    changePath: params.changePath,
    // 0 nExpiryHeight = "no expiry", accepted by consensus. Stay 0 until the
    // app is confirmed to commit to a non-zero expiry (Erwan's
    // APP_COMMITS_TO_EXPIRY_HEIGHT note in transparent-send-plan).
    expiryHeight: 0,
  });

  const { txid } = await deps.broadcast(req.serverUrl, signedTxHex);
  return { txid, signedTxHex };
}
