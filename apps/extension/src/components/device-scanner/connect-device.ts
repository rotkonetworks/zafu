/**
 * Turn a parsed connect code into a wallet, reusing the existing keyring
 * merge-by-ZID plumbing (state/keyring - addZignerUnencrypted already merges
 * into an existing zigner-zafu vault with the same ZID + accountIndex; this
 * module never re-implements that, it only builds the import and tells the
 * caller, beforehand, whether this scan is going to join one).
 */

import type { KeyInfo, ZignerZafuImport } from '../../state/keyring/types';
import { keystoneDeviceId } from '../../utils/viewing-key';
import type { ParsedConnectCode } from './parse-connect-code';

export interface ConnectOutcome {
  vaultId: string;
  network: ParsedConnectCode['network'];
  /** true when this code joined an existing wallet instead of creating one */
  joined: boolean;
  label: string;
}

/** the vault this code would join, if any - computed before the write so the UI can say "joined" up front */
export function findJoinTarget(
  parsed: ParsedConnectCode,
  keyInfos: KeyInfo[],
): KeyInfo | undefined {
  if (!parsed.zidPublicKey) {
    return undefined;
  }
  return keyInfos.find(
    k =>
      k.type === 'zigner-zafu' &&
      k.insensitive['zid'] === parsed.zidPublicKey &&
      k.insensitive['accountIndex'] === parsed.accountIndex,
  );
}

function defaultLabel(parsed: ParsedConnectCode): string {
  if (parsed.label) {
    return parsed.label;
  }
  if (parsed.network === 'penumbra') {
    return 'zigner penumbra';
  }
  return parsed.device === 'keystone' ? 'keystone zcash' : 'zigner zcash';
}

/**
 * Build the keyring import for a parsed code. Device ids are deterministic
 * (never a timestamp) so a re-scan of the same device always resolves to the
 * same vault instead of defeating dedup.
 */
export function buildZignerImport(parsed: ParsedConnectCode): ZignerZafuImport {
  if (parsed.network === 'penumbra') {
    const walletIdB64 = btoa(String.fromCharCode(...parsed.walletIdBytes));
    return {
      fullViewingKey: parsed.fvkBech32m || btoa(String.fromCharCode(...parsed.fvkBytes)),
      accountIndex: parsed.accountIndex,
      deviceId: parsed.zidPublicKey ?? walletIdB64,
      zidPublicKey: parsed.zidPublicKey,
    };
  }

  return {
    viewingKey: parsed.ufvk,
    accountIndex: parsed.accountIndex,
    // no ZID on this device (keystone never has one; pre-ZID zigner firmware
    // doesn't either) - fall back to a hash of the viewing key, never a
    // timestamp, so re-scanning the same device dedups against itself.
    deviceId: parsed.zidPublicKey ?? keystoneDeviceId(parsed.ufvk),
    zidPublicKey: parsed.zidPublicKey,
    coldSignerType: parsed.device,
  };
}

/**
 * Connect a parsed code: build the import, call the existing keyring add
 * (which merges-by-ZID on its own), and optionally set a zcash birthday.
 */
export async function connectDevice(
  parsed: ParsedConnectCode,
  opts: {
    label?: string;
    birthday?: number;
    keyInfos: KeyInfo[];
    addZignerUnencrypted: (data: ZignerZafuImport, name: string) => Promise<string>;
  },
): Promise<ConnectOutcome> {
  const joined = Boolean(findJoinTarget(parsed, opts.keyInfos));
  const zignerData = buildZignerImport(parsed);
  const label = opts.label?.trim() || defaultLabel(parsed);
  const vaultId = await opts.addZignerUnencrypted(zignerData, label);

  if (parsed.network === 'zcash' && opts.birthday) {
    await chrome.storage.local.set({ [`zcashBirthday_${vaultId}`]: opts.birthday });
  }

  return { vaultId, network: parsed.network, joined, label };
}
