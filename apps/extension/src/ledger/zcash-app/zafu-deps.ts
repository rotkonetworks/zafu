/**
 * Production wiring for the Ledger Zcash-app flow: the worker seams (build,
 * extract, broadcast, lookup), the encrypted checkpoint store, and the
 * transaction tracker. The protocol (wasm) and device (WebHID) are passed in by
 * the caller - they are built by other pieces against ./contract.ts.
 *
 * Everything here runs in the PAGE (side panel / tab): WebHID is not available
 * to the service worker, and the toolbar popup is torn down on blur.
 */

import {
  broadcastSignedTxInWorker,
  buildSendTxPcztInWorker,
  buildUnsignedShieldInWorker,
  extractSignedPcztTxInWorker,
  lookupTxInWorker,
  shieldEligibilityInWorker,
} from '../../state/keyring/network-worker';
import { writeTxOp } from '../../tx-ops';
import type { LedgerZcashDevice, LedgerZcashProtocol } from './contract';
import { LedgerError, LEDGER_ZCASH_LIMITS } from './contract';
import { hexToBytes } from '../hex';
import type { LedgerDerivationStamper } from './signer';
import type { LedgerOperationContext, LedgerOperationDeps } from './operation';
import {
  createLedgerOperationStore,
  type LedgerNetwork,
  type LedgerOperationStore,
} from './operations-store';
import { chromeLocalArea, sessionKeySealer } from './sealing';
import type { LedgerRecoveryDeps } from './recovery';
import type { LedgerShieldingDeps } from './shielding-rounds';

let store: LedgerOperationStore | undefined;
export const ledgerOperationStore = (): LedgerOperationStore =>
  (store ??= createLedgerOperationStore({ area: chromeLocalArea, sealer: sessionKeySealer }));

export const ledgerNetwork = (mainnet: boolean): LedgerNetwork => (mainnet ? 'main' : 'test');

/** "PCZT" magic: the Ledger path only ever signs a real PCZT carrier. */
const PCZT_MAGIC_HEX = '50435a54';
export const assertPcztHex = (hex: string, what: string): string => {
  if (!hex.toLowerCase().startsWith(PCZT_MAGIC_HEX)) {
    throw new Error(`${what} is not a PCZT - the Ledger Zcash app signs PCZTs only`);
  }
  return hex;
};

/** The Ledger account the wallet was imported from (account import). */
export interface LedgerAccountRef {
  readonly seedFingerprint: Uint8Array;
  readonly accountIndex: number;
}

/**
 * Read the account reference from the wallet's KeyInfo `insensitive` bag. The
 * account-import piece must persist `seedFingerprint` (hex, from
 * ledger_parse_ufvk) there; without it nothing can be stamped, so fail closed.
 */
export function ledgerAccountFromKeyInfo(
  insensitive: Record<string, unknown> | undefined,
  accountIndex: number,
): LedgerAccountRef {
  const fp = insensitive?.['seedFingerprint'];
  if (typeof fp !== 'string' || !/^[0-9a-f]{64}$/i.test(fp)) {
    throw new LedgerError(
      'unsupported_transaction',
      'this Ledger account has no seed fingerprint on record - re-import it from the device',
    );
  }
  return { seedFingerprint: hexToBytes(fp), accountIndex };
}

/** Bind the protocol's stamper to one account. */
export const accountStamper =
  (protocol: LedgerZcashProtocol, account: LedgerAccountRef): LedgerDerivationStamper =>
  (pczt, { transparentPaths }) =>
    protocol.stampDerivations(pczt, {
      seedFingerprint: account.seedFingerprint,
      accountIndex: account.accountIndex,
      transparentPaths,
    });

export interface ZafuLedgerEnv {
  readonly protocol: LedgerZcashProtocol;
  readonly device: LedgerZcashDevice;
  readonly stampDerivations: LedgerDerivationStamper;
  readonly ctx: LedgerOperationContext;
  readonly serverUrl: string;
  /** true while ctx is still the selected wallet on the selected network */
  readonly isCurrent: (ctx: LedgerOperationContext) => boolean;
}

export function zafuLedgerDeps(env: ZafuLedgerEnv): LedgerOperationDeps {
  return {
    protocol: env.protocol,
    device: env.device,
    stampDerivations: env.stampDerivations,
    store: ledgerOperationStore(),
    isCurrent: env.isCurrent,
    extractTx: signedPcztHex => extractSignedPcztTxInWorker(signedPcztHex),
    broadcast: (walletId, txHex, coldSendId) =>
      broadcastSignedTxInWorker(walletId, env.serverUrl, txHex, coldSendId),
    track: (opId, label, u) =>
      void writeTxOp(opId, {
        network: 'zcash',
        label,
        status: u.status,
        step: u.step,
        ...(u.txId ? { txId: u.txId } : {}),
        ...(u.error ? { error: u.error } : {}),
      }).catch(() => undefined),
  };
}

export interface ZafuShieldEnv extends ZafuLedgerEnv {
  readonly ufvk: string;
  readonly tAddresses: string[];
  readonly mainnet: boolean;
}

export function zafuShieldingDeps(env: ZafuShieldEnv): LedgerShieldingDeps {
  return {
    ...zafuLedgerDeps(env),
    readEligible: () =>
      shieldEligibilityInWorker(
        env.serverUrl,
        env.tAddresses,
        LEDGER_ZCASH_LIMITS.maxTransparentInputs,
      ),
    buildShieldPczt: async maxInputs => {
      const built = await buildUnsignedShieldInWorker(
        'zcash',
        env.ctx.walletId,
        env.serverUrl,
        env.tAddresses,
        env.mainnet,
        env.ufvk,
        { maxInputs },
      );
      // the ironwood builder returns the unredacted PCZT carrier; its inputs
      // belong to one address index and one pubkey, in UTXO order
      if (!built.transparentPubkeyHex) {
        throw new LedgerError(
          'unsupported_transaction',
          'ledger shielding needs the ironwood builder (after NU6.3)',
        );
      }
      const pubkey = hexToBytes(built.transparentPubkeyHex);
      return {
        pcztHex: assertPcztHex(built.unsignedTxHex, 'the shielding build'),
        transparentPaths: built.addressIndices.map((addressIndex, inputIndex) => ({
          inputIndex,
          scope: 0 as const,
          addressIndex,
          pubkey,
        })),
      };
    },
  };
}

/** Build the unsigned send PCZT (un-redacted: the Ledger is a trusted signer). */
export async function buildLedgerSendPczt(a: {
  walletId: string;
  serverUrl: string;
  recipient: string;
  amountZat: string;
  memo: string;
  mainnet: boolean;
  ufvk: string;
}): Promise<{ pcztHex: string; coldSendId?: string; fee: string }> {
  const built = await buildSendTxPcztInWorker(
    'zcash',
    a.walletId,
    a.serverUrl,
    a.recipient,
    a.amountZat,
    a.memo,
    0, // anchor to the live tip, like the zigner branch
    a.mainnet,
    a.ufvk,
  );
  return {
    pcztHex: assertPcztHex(built.pcztHex, 'the send build'),
    ...(built.coldSendId ? { coldSendId: built.coldSendId } : {}),
    fee: built.fee,
  };
}

export function zafuRecoveryDeps(serverUrl: string): LedgerRecoveryDeps {
  return {
    store: ledgerOperationStore(),
    broadcast: (walletId, txHex, coldSendId) =>
      broadcastSignedTxInWorker(walletId, serverUrl, txHex, coldSendId),
    lookupTx: txid => lookupTxInWorker(serverUrl, txid),
  };
}
