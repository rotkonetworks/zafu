/**
 * Pure parsing for a cold-signer "connect code" - the QR (or pasted text)
 * a zigner or keystone shows to join a wallet to zafu.
 *
 * Zigner's scope is zcash and penumbra only. A code carries ONE network;
 * `mergeZignerCapabilities` (state/keyring) is what lets a second network's
 * code join the same wallet. Device type comes from the caller's declared
 * hint (which button was pressed) when given, otherwise from the payload -
 * the presence of a ZID public key is a zigner tell, never the other way
 * around, so it is only a consistency check, not a source of truth.
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
  /** a recognized but out-of-scope network (substrate/cosmos) */
  | 'unsupported-network'
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

/** networks zigner/keystone connect codes no longer support - declined calmly */
const UNSUPPORTED_PREFIXES: { prefix: string; network: string }[] = [
  { prefix: 'substrate:', network: 'polkadot' },
  { prefix: 'cosmos:', network: 'cosmos' },
];

/**
 * Parse a single-frame connect code payload (raw QR text, or pasted text).
 *
 * `declaredDevice` is the user's explicit choice (which button they pressed),
 * trusted over the byte-level ZID heuristic - see the module doc.
 */
export function parseConnectCode(payload: string, declaredDevice?: ConnectDevice): ConnectCodeResult {
  const trimmed = payload.trim();
  if (!trimmed) {
    return err('garbage', 'no code to read yet.');
  }

  if (trimmed.startsWith('{') && trimmed.includes('"cosmos-accounts"')) {
    return err('unsupported-network', 'this code is for cosmos, which zigner no longer connects here.');
  }
  for (const { prefix, network } of UNSUPPORTED_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return err('unsupported-network', `this code is for ${network}, which zigner no longer connects here.`);
    }
  }

  if (isUrString(trimmed)) {
    return parseUr(trimmed, declaredDevice);
  }

  // legacy binary format (pre-UR zigner firmware)
  const network = detectQRNetwork(trimmed);
  if (network === 'penumbra' && isZignerFvkQR(trimmed)) {
    try {
      return fromPenumbraExport(parseZignerFvkQR(trimmed), 'zigner');
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this penumbra code did not read.'));
    }
  }
  if (network === 'zcash' && isZcashFvkQR(trimmed)) {
    try {
      return fromZcashExport(parseZcashFvkQR(trimmed), declaredDevice ?? 'zigner');
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this zcash code did not read.'));
    }
  }

  return err('garbage', 'not a connect code. please show the connect code and try again.');
}

function parseUr(trimmed: string, declaredDevice?: ConnectDevice): ConnectCodeResult {
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
      return err('garbage', readableCause(cause, 'this penumbra code did not read.'));
    }
  }

  if (urType === 'zcash-accounts') {
    try {
      const urExport = parseZcashUr(trimmed);
      return {
        ok: true,
        network: 'zcash',
        device: pickDevice(declaredDevice, Boolean(urExport.zidPublicKey)),
        accountIndex: urExport.accountIndex,
        label: urExport.label,
        ufvk: urExport.ufvk,
        orchardFvk: null,
        mainnet: urExport.ufvk.startsWith('uview1'),
        zidPublicKey: urExport.zidPublicKey,
      };
    } catch (cause) {
      return err('garbage', readableCause(cause, 'this zcash code did not read.'));
    }
  }

  if (urType === 'zcash-pczt' || urType === 'zid-response') {
    return err(
      'signing-request',
      'this looks like a signing request, not a connect code. please show the connect code instead.',
    );
  }

  return err('garbage', `unsupported code: ur:${urType ?? 'unknown'}.`);
}

/**
 * Parse a `zcash-accounts` CBOR payload already reassembled from a
 * multi-frame (fountain-coded) scan - the path an animated/Keystone-class
 * scan takes, as distinct from a single-frame UR string.
 */
export function parseConnectCodeBytes(
  cbor: Uint8Array,
  declaredDevice: ConnectDevice,
): ConnectCodeResult {
  try {
    const urExport = parseZcashAccountsCbor(cbor);
    return fromZcashUrExport(urExport, declaredDevice);
  } catch (cause) {
    return err('garbage', readableCause(cause, 'this code did not read.'));
  }
}

function fromZcashUrExport(
  urExport: { ufvk: string; accountIndex: number; label: string | null; zidPublicKey?: string },
  declaredDevice: ConnectDevice,
): ParsedZcashCode {
  // The byte heuristic - "zid_pubkey present implies zigner" - is only a
  // consistency check against the declared device, never the source of
  // truth (see module doc); log so drift is visible without ever silently
  // overriding what the user told us.
  const heuristic: ConnectDevice = urExport.zidPublicKey ? 'zigner' : 'keystone';
  if (heuristic !== declaredDevice) {
    console.warn(
      `[device-scanner] declared "${declaredDevice}" but the code looks like "${heuristic}" ` +
        `(zid_pubkey ${urExport.zidPublicKey ? 'present' : 'absent'}). trusting the declaration.`,
    );
  }
  return {
    ok: true,
    network: 'zcash',
    device: declaredDevice,
    accountIndex: urExport.accountIndex,
    label: urExport.label,
    ufvk: urExport.ufvk,
    orchardFvk: null,
    mainnet: urExport.ufvk.startsWith('uview1'),
    zidPublicKey: urExport.zidPublicKey,
  };
}

function fromZcashExport(exportData: ZcashFvkExportData, device: ConnectDevice): ParsedZcashCode {
  return {
    ok: true,
    network: 'zcash',
    device,
    accountIndex: exportData.accountIndex,
    label: exportData.label,
    ufvk: exportData.ufvk ?? null,
    orchardFvk: exportData.orchardFvk ?? null,
    mainnet: exportData.mainnet,
    zidPublicKey: exportData.zidPublicKey,
  };
}

function fromPenumbraExport(
  exportData: ZignerFvkExportData,
  device: 'zigner',
): ParsedPenumbraCode {
  return {
    ok: true,
    network: 'penumbra',
    device,
    accountIndex: exportData.accountIndex,
    label: exportData.label,
    walletIdBytes: exportData.walletIdBytes,
    fvkBytes: exportData.fvkBytes,
    fvkBech32m: exportData.fvkBech32m ?? '',
    zidPublicKey: exportData.zidPublicKey,
  };
}

/** declared device wins; the zid heuristic only fills in when none was given */
function pickDevice(declared: ConnectDevice | undefined, zidPresent: boolean): ConnectDevice {
  return declared ?? (zidPresent ? 'zigner' : 'keystone');
}

function readableCause(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message || fallback;
}
