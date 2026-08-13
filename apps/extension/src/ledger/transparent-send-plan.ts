/**
 * Assembly layer for a Ledger transparent (t->t) send.
 *
 * `ledgerTransparentSend` (./transparent.ts) is the wire-level device driver: it
 * wants a fully-formed `LedgerTransparentSendParams` - inputs already carrying
 * their prev-tx bytes, outputs already reduced to raw scriptPubKey hex, change
 * routed, heights computed. This module is the piece that turns "spend N zat
 * from these Ledger UTXOs to this address" into exactly that structure.
 *
 * THE UTXO SOURCE IS REAL, NOT STUBBED. zafu already fetches spendable
 * transparent UTXOs *with their full previous-transaction bytes*: the zcash
 * worker's `get-transparent-utxos` case (getAddressUtxos + a getTransaction per
 * funding txid) returns `TransparentUtxoInfo { txid, vout, valueZat, scriptHex,
 * prevTxHex }`, surfaced on the main thread as `getTransparentUtxosInWorker`.
 * That is precisely the shape `LedgerUtxo` needs, so this module maps it
 * directly - no fake prevTxHex.
 *
 * ONE HONEST CONSTRAINT (not a stub, a property of the chain): `prevTxHex` is
 * whatever consensus bytes funded the UTXO. `ledgerTransparentSend` feeds it
 * through `zcashV5PrevTxToLedgerWire`, which ONLY accepts a v5 transaction with
 * no shielded bundles. A UTXO funded by a v4 (pre-NU5) transaction, or by a
 * transaction that also carries a sapling/orchard bundle, is rejected there. In
 * practice a Ledger t-addr funded by a normal transparent or shielding send is
 * fine; a legacy v4 funding tx is not spendable via this path until the device
 * framing learns v4. We do not pre-filter here - the reject is loud and belongs
 * next to the encoder that owns the rule.
 */

import type { TransparentUtxoInfo } from '../state/keyring/network-worker';
import { transparentAddressToScriptHex } from './address';
import { transparentPath } from './transparent';
import type { LedgerUtxo, LedgerOutput, LedgerTransparentSendParams } from './transparent';

/** Where the leftover value goes. Ledger needs the change output present in the
 *  output set AND its derivation path, so the device can recognise (and not
 *  re-display) it and derive its script itself. */
export interface LedgerTransparentChange {
  /** the change t-address (must derive from `path`). */
  readonly address: string;
  /** BIP44 path the device derives the change key under. */
  readonly path: string;
}

export interface LedgerTransparentSendPlanInput {
  /** the exact inputs to spend, each with its prev-tx bytes (from
   *  `getTransparentUtxosInWorker`). Use {@link selectTransparentUtxos} to pick
   *  them, or pass a caller-chosen set. */
  readonly utxos: readonly TransparentUtxoInfo[];
  readonly recipientAddress: string;
  readonly amountZat: bigint;
  /** the fee the transaction should pay. The device derives fee implicitly as
   *  sum(inputs) - sum(outputs); we size the change output so that difference
   *  equals this. */
  readonly feeZat: bigint;
  /** required whenever there is leftover value; omitting it when change > 0 is
   *  refused rather than silently burning the remainder to fee. */
  readonly change?: LedgerTransparentChange;
  /** the Ledger account these UTXOs belong to; the default input path is
   *  `44'/coin'/accountIndex'/0/0`. */
  readonly accountIndex: number;
  readonly mainnet: boolean;
  /** chain tip height; sets the signer-kit branch id (must be NU6.3-recognising
   *  on the target app - `ledgerTransparentSend` gates that). */
  readonly blockHeight: number;
  /** LEAVE UNSET on any released app. `ledgerTransparentSend` refuses a non-zero
   *  expiry because app-zcash 3.6.0 does not commit to it in the transparent
   *  sighash (see APP_COMMITS_TO_EXPIRY_HEIGHT). Wired through for the app
   *  release that fixes it. */
  readonly expiryHeight?: number;
  /**
   * Per-input derivation path. The current Ledger onboarding derives a SINGLE
   * transparent address (index 0), so the default - the account's `/0/0` path
   * for every input - is correct today. A multi-address Ledger t-account would
   * pass this to map each UTXO's address to its own path; TransparentUtxoInfo
   * does not carry the address, so that mapping has to be supplied by the
   * caller that knows which address each UTXO came from.
   */
  readonly pathForUtxo?: (u: TransparentUtxoInfo) => string;
}

export interface LedgerTransparentSendPlan {
  readonly params: LedgerTransparentSendParams;
  readonly totalInZat: bigint;
  readonly changeZat: bigint;
}

function toSafeNumber(zat: bigint, what: string): number {
  if (zat < 0n) {
    throw new Error(`ledger plan: ${what} is negative (${zat})`);
  }
  if (zat > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ledger plan: ${what} ${zat} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(zat);
}

/**
 * Greedy largest-first selection to cover `amountZat + feeZat`. Returns the
 * chosen inputs and their total. Does NOT re-estimate the fee as inputs are
 * added - the caller owns fee policy (zafu computes transparent fees per-input
 * elsewhere); pass a fee already sized for the expected input count, or select
 * then recompute and re-select.
 */
export function selectTransparentUtxos(
  utxos: readonly TransparentUtxoInfo[],
  targetZat: bigint,
): { selected: TransparentUtxoInfo[]; totalZat: bigint } {
  const sorted = [...utxos].sort((a, b) => (a.valueZat < b.valueZat ? 1 : -1));
  const selected: TransparentUtxoInfo[] = [];
  let totalZat = 0n;
  for (const u of sorted) {
    if (totalZat >= targetZat) {
      break;
    }
    selected.push(u);
    totalZat += BigInt(u.valueZat);
  }
  if (totalZat < targetZat) {
    throw new Error(
      `ledger plan: insufficient transparent balance - have ${totalZat} zat, need ${targetZat}`,
    );
  }
  return { selected, totalZat };
}

/**
 * Assemble `LedgerTransparentSendParams` from a selected UTXO set.
 *
 * Pure/async assembly - it fetches nothing and touches no device. The only
 * async work is checksum-verified address -> script conversion (crypto.subtle).
 */
export async function planLedgerTransparentSend(
  input: LedgerTransparentSendPlanInput,
): Promise<LedgerTransparentSendPlan> {
  const {
    utxos,
    recipientAddress,
    amountZat,
    feeZat,
    change,
    accountIndex,
    mainnet,
    blockHeight,
    expiryHeight,
    pathForUtxo,
  } = input;

  if (utxos.length === 0) {
    throw new Error('ledger plan: no utxos to spend');
  }
  if (amountZat <= 0n) {
    throw new Error(`ledger plan: send amount must be positive (${amountZat})`);
  }
  if (feeZat < 0n) {
    throw new Error(`ledger plan: fee must be non-negative (${feeZat})`);
  }

  const totalInZat = utxos.reduce((sum, u) => sum + BigInt(u.valueZat), 0n);
  const spendZat = amountZat + feeZat;
  if (totalInZat < spendZat) {
    throw new Error(
      `ledger plan: inputs total ${totalInZat} zat, need ${spendZat} (amount + fee)`,
    );
  }
  const changeZat = totalInZat - spendZat;

  const outputs: LedgerOutput[] = [
    {
      scriptPubKeyHex: await transparentAddressToScriptHex(recipientAddress, mainnet),
      valueZat: toSafeNumber(amountZat, 'send amount'),
    },
  ];

  let changePath: string | undefined;
  if (changeZat > 0n) {
    if (!change) {
      throw new Error(
        `ledger plan: ${changeZat} zat of change but no change address/path given - ` +
          'refusing to burn the remainder to fee. Provide `change`, or raise the fee ' +
          'to consume it deliberately.',
      );
    }
    outputs.push({
      scriptPubKeyHex: await transparentAddressToScriptHex(change.address, mainnet),
      valueZat: toSafeNumber(changeZat, 'change'),
    });
    changePath = change.path;
  }

  const defaultPath = transparentPath(accountIndex, mainnet);
  const ledgerUtxos: LedgerUtxo[] = utxos.map(u => ({
    txid: u.txid,
    vout: u.vout,
    valueZat: toSafeNumber(BigInt(u.valueZat), `utxo ${u.txid}:${u.vout} value`),
    prevTxHex: u.prevTxHex,
    path: pathForUtxo?.(u) ?? defaultPath,
  }));

  const params: LedgerTransparentSendParams = {
    utxos: ledgerUtxos,
    outputs,
    changePath,
    blockHeight,
    expiryHeight,
    mainnet,
  };

  return { params, totalInZat, changeZat };
}
