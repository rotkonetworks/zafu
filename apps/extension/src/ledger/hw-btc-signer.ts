/**
 * hw-app-btc transparent Zcash signer - the LEGACY (Bitcoin-app) Ledger path.
 *
 * WHY THIS EXISTS alongside the DMK path (transparent.ts / signer.ts):
 * zafu's first Ledger integration targeted the dedicated Zcash app via
 * @ledgerhq/device-signer-kit-zcash (DMK). Post-NU6.3 that path is blocked on
 * LedgerHQ shipping - the released app does not know the NU6.3 branch id (6a80)
 * and the released signer-kit frames the SIGN apdu wrong for it (6700), neither
 * fixable from our side (see capabilities.ts).
 *
 * The BITCOIN app (@ledgerhq/hw-app-btc) signs Zcash TRANSPARENT transactions
 * and DOES work on mainnet today - it is the path Zashi and Ledger Live use, and
 * LedgerHQ shipped its NU6.3 branch-id + v5/v6 parsing there. So this module is
 * how a Ledger holder can send/receive transparent ZEC in zafu now and migrate
 * off other wallets, while the shielded (ironwood) path waits on the DMK app.
 *
 * TRANSPARENT ONLY. Shielded/orchard/ironwood is not reachable through the
 * Bitcoin app - use the DMK path for that once LedgerHQ publishes.
 *
 * DEVICE-TEST GATE: the money-path specifics below (expiryHeight buffer layout,
 * v5 prev-tx parsing via splitTransaction, sigHashType) are asserted from the
 * hw-app-btc 11.3.1 types + the standard Zcash usage, but NOT yet confirmed
 * against a physical device signing a real mainnet t->t tx. Do not enable for
 * users until that test passes.
 */

import Btc from '@ledgerhq/hw-app-btc';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';

/** The concrete WebHID transport instance type (a subtype of the base
 *  `@ledgerhq/hw-transport` the Btc app accepts) - derived from the installed
 *  package so we do not need hw-transport as a direct dependency. */
export type LedgerBtcTransport = Awaited<ReturnType<typeof TransportWebHID.create>>;

/** Zcash BIP44 coin type. A transparent path is `44'/133'/account'/change/index`. */
export const ZCASH_COIN_TYPE = 133;

/** hw-app-btc reads the Zcash-specific tx shape (v5 sapling/orchard sections in
 *  splitTransaction, the Zcash sighash) from this `additionals` list. */
const ZEC_ADDITIONALS = ['zcash', 'sapling'];

/** Build the default transparent derivation path for an account/index. */
export function zcashTransparentPath(account = 0, index = 0, change = 0): string {
  return `44'/${ZCASH_COIN_TYPE}'/${account}'/${change}/${index}`;
}

/** Whether this browser exposes WebHID (Ledger connect needs it). */
export function isLedgerBtcSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/**
 * Open a WebHID transport to a Ledger. MUST be called from a live user gesture
 * (a click) in a persistent surface - a tab or the side panel, never the
 * toolbar popup, which is torn down on blur and drops the USB session mid-sign.
 * `request()` shows the device picker on first pairing; a paired device could
 * use `openConnected()` to skip it, but request() is the safe default.
 */
export async function connectLedgerBtc(): Promise<LedgerBtcTransport> {
  return TransportWebHID.request();
}

export interface HwBtcUtxo {
  /** Raw previous transaction, consensus wire bytes (hex). splitTransaction
   *  parses it directly with the zcash additionals - this is the UN-converted
   *  prevTxHex from the worker's get-transparent-utxos, NOT the DMK wire form. */
  readonly prevTxHex: string;
  /** Index of the output being spent in that prev tx. */
  readonly vout: number;
  /** BIP44 derivation path controlling this UTXO, e.g. `44'/133'/0'/0/0`. */
  readonly path: string;
}

export interface HwBtcSendParams {
  readonly utxos: readonly HwBtcUtxo[];
  /** Serialized outputs: varint(count) || per output value(8,LE) || varint(len)
   *  || scriptPubKey. Same layout as hw-app-btc's serializeTransactionOutputs
   *  and Erwan's buildOutputScriptHex, so either can produce it. */
  readonly outputScriptHex: string;
  /** Change back to one of our transparent paths; hw-app-btc appends the change
   *  output itself when set. Omit when there is no change. */
  readonly changePath?: string;
  /** Zcash nExpiryHeight (a height, not pre-encoded). */
  readonly expiryHeight: number;
  readonly lockTime?: number;
}

/** Zcash nExpiryHeight is a u32 little-endian. UNVERIFIED against hw-app-btc's
 *  exact byte expectation - confirm on device before shipping. */
function expiryHeightBuffer(height: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(height >>> 0, 0);
  return b;
}

/**
 * Read a transparent t-address (and its pubkey) from the device. `format`
 * 'legacy' yields a P2PKH t1... address for the Zcash currency.
 */
export async function getLedgerZcashTransparentAddress(
  transport: LedgerBtcTransport,
  path: string = zcashTransparentPath(),
): Promise<{ address: string; publicKeyHex: string }> {
  const btc = new Btc({ transport, currency: 'zcash' });
  const { bitcoinAddress, publicKey } = await btc.getWalletPublicKey(path, { format: 'legacy' });
  return { address: bitcoinAddress, publicKeyHex: publicKey };
}

/**
 * Sign a transparent Zcash send on a connected Ledger via the Bitcoin app and
 * return the fully-signed raw transaction hex, ready to broadcast.
 *
 * The caller opens the WebHID transport (needs a live user gesture in a document
 * that survives the transfer - a tab or side panel, never the toolbar popup) and
 * assembles the plan (Erwan's transparent-send-plan feeds every field here).
 */
export async function signZcashTransparentWithLedger(
  transport: LedgerBtcTransport,
  params: HwBtcSendParams,
): Promise<string> {
  if (params.utxos.length === 0) {
    throw new Error('ledger transparent send: no utxos to spend');
  }

  const btc = new Btc({ transport, currency: 'zcash' });

  // Each input is [parsed prev tx, output index, redeemScript?, sequence?].
  // splitTransaction is told this is a zcash tx so it parses the v5 sapling /
  // orchard sections rather than mis-reading them as bitcoin witness data.
  const inputs = params.utxos.map(
    u =>
      [btc.splitTransaction(u.prevTxHex, true, false, ZEC_ADDITIONALS), u.vout, null, null] as [
        ReturnType<Btc['splitTransaction']>,
        number,
        null,
        null,
      ],
  );

  const associatedKeysets = params.utxos.map(u => u.path);

  return btc.createPaymentTransaction({
    inputs,
    associatedKeysets,
    changePath: params.changePath,
    outputScriptHex: params.outputScriptHex,
    additionals: ZEC_ADDITIONALS,
    expiryHeight: expiryHeightBuffer(params.expiryHeight),
    lockTime: params.lockTime ?? 0,
    sigHashType: 1,
  });
}
