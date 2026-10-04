/**
 * Build + download FROST backup files. Pulls share secrets via
 * keyRing.getMultisigSecrets, seals with the user-supplied passphrase,
 * triggers a browser download.
 */

import { useStore } from '../../../../state';
import {
  sealBackup,
  backupFilename,
  type FrostSharePayload,
} from '../../../../state/keyring/multisig-backup';
import type { ZcashWalletJson } from '../../../../state/wallets';

const downloadJson = (filename: string, jsonText: string) => {
  const blob = new Blob([jsonText], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const markBackedUp = async (wallets: readonly ZcashWalletJson[]) => {
  const { updateMultisigWallet } = useStore.getState().wallets;
  const at = Date.now();
  for (const w of wallets) {
    await updateMultisigWallet(w.id, { backedUpAt: at });
  }
};

const buildSharePayload = async (
  wallet: ZcashWalletJson,
): Promise<Omit<FrostSharePayload, 'version' | 'type'>> => {
  if (!wallet.multisig) {
    throw new Error(`wallet ${wallet.id} has no multisig data`);
  }
  if (wallet.multisig.custody === 'airgapSigner') {
    throw new Error(
      `"${wallet.label}" is an airgap wallet - its share lives on zigner. Export from the zigner device.`,
    );
  }
  const secrets = await useStore.getState().keyRing.getMultisigSecrets(wallet.vaultId);
  if (!secrets) {
    throw new Error(`failed to read share for "${wallet.label}" - is the wallet unlocked?`);
  }
  return {
    label: wallet.label,
    publicKeyPackage: wallet.multisig.publicKeyPackage,
    keyPackage: secrets.keyPackage,
    ephemeralSeed: secrets.ephemeralSeed,
    threshold: wallet.multisig.threshold,
    maxSigners: wallet.multisig.maxSigners,
    mainnet: wallet.mainnet,
    orchardFvk: wallet.orchardFvk,
    address: wallet.address,
    relayUrl: wallet.multisig.relayUrl,
    createdAt: Date.now(),
    ...(wallet.multisig.room ? { room: wallet.multisig.room } : {}),
  };
};

/** export a single self-custody multisig wallet as `frost-backup-<label>-<date>.json`. */
export const exportSingleBackup = async (
  wallet: ZcashWalletJson,
  passphrase: string,
): Promise<void> => {
  const share = await buildSharePayload(wallet);
  const payload: FrostSharePayload = { version: 1, type: 'frost-share', ...share };
  const envelope = await sealBackup(payload, passphrase, {
    label: wallet.label,
    publicKeyPackage: wallet.multisig!.publicKeyPackage,
  });
  downloadJson(backupFilename(wallet.label, false), JSON.stringify(envelope, null, 2));
  await markBackedUp([wallet]);
};
