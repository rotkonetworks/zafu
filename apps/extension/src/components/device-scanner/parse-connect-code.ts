/**
 * Pure parsing for a cold-signer "connect code" - the QR (or pasted text)
 * a zigner or keystone shows to join a wallet to zafu. There is one scanner
 * for every signer; the user never picks a brand beforehand - this module
 * classifies the code and the brand only appears once it has.
 *
 * Zigner's scope is zcash and penumbra only. A code carries ONE network;
 * `mergeZignerCapabilities` (state/keyring) is what lets a second network's
 * code join the same wallet. Device type is always derived from the payload:
 * a ZID public key is a zigner tell (isLikelyKeystoneAccountsExport), never
 * a user choice - there is no "which device" button to trust instead.
 *
 * No React, no store, no chrome APIs here - this is unit-testable on its
 * own (see parse-connect-code.test.ts).
 */

import {
  parseZignerFvkQR,
  isZignerFvkQR,
  type ZignerFvkExportData,
} from '@repo/wallet/zigner-signer';
import {
  parseZcashFvkQR,
  isZcashFvkQR,
  detectQRNetwork,
  type ZcashFvkExportData,
} from '@repo/wallet/zcash-zigner';
import {
  isUrString,
  getUrType,
  parsePenumbraUr,
  parseZcashUr,
  parseZcashAccountsCbor,
  isLikelyKeystoneAccountsExport,
} from '@repo/wallet/ur-parser';

export type ConnectDevice = 'zigner' | 'keystone';
export type ConnectNetwork = 'zcash' | 'penumbra';

export interface ParsedZcashCode {
  ok: true;
  network: 'zcash';
  device: ConnectDevice;
  accountIndex: number;
  label: string | null;
  /** unified full viewing key string, when the payload carries one */
  ufvk: string | null;
  /** raw orchard fvk bytes, for the legacy (pre-UR) binary QR format */
  orchardFvk: Uint8Array | null;
  mainnet: boolean;
  zidPublicKey?: string;
}

export interface ParsedPenumbraCode {
  ok: true;
  network: 'penumbra';
  /** keystone does not export penumbra */
  device: 'zigner';
  accountIndex: number;
  label: string | null;
  walletIdBytes: Uint8Array;
  fvkBytes: Uint8Array;
  fvkBech32m: string;
  zidPublicKey?: string;
}

export type ParsedConnectCode = ParsedZcashCode | ParsedPenumbraCode;

export type ConnectCodeErrorReason =
  /** a recognized code from a different flow (e.g. a pending signing request) */
  | 'signing-request'
  /** not recognized as a connect code at all */
  | 'garbage';

export interface ConnectCodeError {
  ok: false;
  reason: ConnectCodeErrorReason;
  message: string;
}

export type ConnectCodeResult = ParsedConnectCode | ConnectCodeError;

const err = (reason: ConnectCodeErrorReason, message: string): ConnectCodeError => ({
  ok: false,
  reason,
  message,
});

const NOT_A_CONNECT_CODE = 'not a connect code. please show the connect code and try again.';

/** parse a single-frame connect code payload (raw QR text, or pasted text) */
export function parseConnectCode(payload: string): ConnectCodeResult {
  const trimmed = payload.trim();
  if (!trimmed) {
    return err('garbage', 'no code to read yet.');
  }

  if (isUrString(trimmed)) {
    return parseUr(trimmed);
  }

  // legacy binary format (pre-UR zigner firmware)
  const network = detectQRNetwork(trimmed);
  if (network === 'penumbra' && isZignerFvkQR(trimmed)) {
    try {
      return fromPenumbraExport(parseZignerFvkQR(trimmed));
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this code did not read.'));
    }
  }
  if (network === 'zcash' && isZcashFvkQR(trimmed)) {
    try {
      return fromZcashExport(parseZcashFvkQR(trimmed));
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this code did not read.'));
    }
  }

  return err('garbage', NOT_A_CONNECT_CODE);
}

function parseUr(trimmed: string): ConnectCodeResult {
  const urType = getUrType(trimmed);

  if (urType === 'penumbra-accounts') {
    try {
      const urExport = parsePenumbraUr(trimmed);
      return {
        ok: true,
        network: 'penumbra',
        device: 'zigner',
        accountIndex: urExport.accountIndex,
        label: urExport.label,
        walletIdBytes: urExport.walletId,
        fvkBytes: new Uint8Array(64), // decoded from bech32m by the caller
        fvkBech32m: urExport.fvk,
        zidPublicKey: urExport.zidPublicKey,
      };
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this code did not read.'));
    }
  }

  if (urType === 'zcash-accounts') {
    try {
      return fromZcashUrExport(parseZcashUr(trimmed));
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this code did not read.'));
    }
  }

  if (urType === 'zcash-pczt' || urType === 'zid-response') {
    return err(
      'signing-request',
      'this looks like a signing request, not a connect code. please show the connect code instead.',
    );
  }

  return err('garbage', NOT_A_CONNECT_CODE);
}

/**
 * Parse a `zcash-accounts` CBOR payload already reassembled from a
 * multi-frame (fountain-coded) scan - the path an animated/Keystone-class
 * scan takes, as distinct from a single-frame UR string.
 */
export function parseConnectCodeBytes(cbor: Uint8Array): ConnectCodeResult {
  try {
    return fromZcashUrExport(parseZcashAccountsCbor(cbor));
  } catch (cause) {
    return err('garbage', readableCause(cause, 'this code did not read.'));
  }
}

function fromZcashUrExport(urExport: {
  ufvk: string;
  accountIndex: number;
  label: string | null;
  zidPublicKey?: string;
}): ParsedZcashCode {
  return {
    ok: true,
    network: 'zcash',
    device: isLikelyKeystoneAccountsExport(urExport) ? 'keystone' : 'zigner',
    accountIndex: urExport.accountIndex,
    label: urExport.label,
    ufvk: urExport.ufvk,
    orchardFvk: null,
    mainnet: urExport.ufvk.startsWith('uview1'),
    zidPublicKey: urExport.zidPublicKey,
  };
}

function fromZcashExport(exportData: ZcashFvkExportData): ParsedZcashCode {
  return {
    ok: true,
    network: 'zcash',
    device:
      exportData.zidPublicKey || !exportData.coldSignerType ? 'zigner' : exportData.coldSignerType,
    accountIndex: exportData.accountIndex,
    label: exportData.label,
    ufvk: exportData.ufvk ?? null,
    orchardFvk: exportData.orchardFvk ?? null,
    mainnet: exportData.mainnet,
    zidPublicKey: exportData.zidPublicKey,
  };
}

function fromPenumbraExport(exportData: ZignerFvkExportData): ParsedPenumbraCode {
  return {
    ok: true,
    network: 'penumbra',
    device: 'zigner',
    accountIndex: exportData.accountIndex,
    label: exportData.label,
    walletIdBytes: exportData.walletIdBytes,
    fvkBytes: exportData.fvkBytes,
    fvkBech32m: exportData.fvkBech32m ?? '',
    zidPublicKey: exportData.zidPublicKey,
  };
}

function readableCause(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message || fallback;
}
