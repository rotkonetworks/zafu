/**
 * Shared helpers for importing one zigner device across both networks.
 *
 * The onboarding / "pair zigner" tab used to keep only the last code scanned
 * and then import only that one, so scanning the other network dropped the
 * first. These helpers keep both parsed codes and add them in order, joining
 * the second into the vault the first created (by ZID, or by that vault id
 * when a ZID is missing).
 */

import type { ZignerZafuImport } from './keyring';
import { keystoneDeviceId } from '../utils/viewing-key';
import type { ZignerFvkExportData } from '@repo/wallet/zigner-signer';
import type { ZcashFvkExportData } from '@repo/wallet/zcash-zigner';
export interface CosmosImportLike {
  publicKey: string;
  xpub?: string;
  accountIndex: number;
  label: string;
  addresses: { chainId: string; address: string; prefix: string }[];
}

export interface CompanionExports {
  parsedPenumbraExport?: ZignerFvkExportData;
  parsedZcashExport?: ZcashFvkExportData;
}

/** Keep the other network's already-scanned code when a new code arrives. */
export function keepCompanionExports(
  prev: CompanionExports,
  next: CompanionExports,
): CompanionExports {
  return {
    parsedPenumbraExport: next.parsedPenumbraExport ?? prev.parsedPenumbraExport,
    parsedZcashExport: next.parsedZcashExport ?? prev.parsedZcashExport,
  };
}

export interface WalletImportLike {
  fullViewingKey: { inner?: Uint8Array };
  walletId: { inner?: Uint8Array };
  accountIndex: number;
  zidPublicKey?: string;
}

export interface ZcashWalletImportLike {
  ufvk?: string;
  accountIndex: number;
  zidPublicKey?: string;
  coldSignerType?: 'zigner' | 'keystone' | 'viewing-key';
}

export interface PendingZignerAdd {
  data: ZignerZafuImport;
  name: string;
}

export function pendingZignerAdds(opts: {
  walletImport?: WalletImportLike;
  zcashWalletImport?: ZcashWalletImportLike;
  parsedCosmosExport?: CosmosImportLike;
  walletLabel?: string;
}): PendingZignerAdd[] {
  const out: PendingZignerAdd[] = [];
  const label = opts.walletLabel?.trim();

  if (opts.walletImport) {
    const fvkInner = opts.walletImport.fullViewingKey.inner;
    const walletIdInner = opts.walletImport.walletId.inner;
    const legacyDeviceId = walletIdInner
      ? btoa(String.fromCharCode(...walletIdInner))
      : 'penumbra-unknown';
    out.push({
      name: label || 'zigner penumbra',
      data: {
        fullViewingKey: fvkInner ? btoa(String.fromCharCode(...fvkInner)) : undefined,
        accountIndex: opts.walletImport.accountIndex,
        deviceId: opts.walletImport.zidPublicKey ?? legacyDeviceId,
        zidPublicKey: opts.walletImport.zidPublicKey,
      },
    });
  }

  if (opts.zcashWalletImport) {
    const kind = opts.zcashWalletImport.coldSignerType ?? 'zigner';
    const ufvk = opts.zcashWalletImport.ufvk;
    const deviceId =
      opts.zcashWalletImport.zidPublicKey ??
      (kind === 'keystone' && ufvk ? keystoneDeviceId(ufvk) : 'zcash-unknown');
    out.push({
      name: label || (kind === 'keystone' ? 'keystone zcash' : 'zigner zcash'),
      data: {
        viewingKey: ufvk,
        accountIndex: opts.zcashWalletImport.accountIndex,
        deviceId,
        zidPublicKey: opts.zcashWalletImport.zidPublicKey,
        coldSignerType: kind,
      },
    });
  }

  // cosmos-only leftover path: never mix it into a zcash/penumbra add
  if (out.length === 0 && opts.parsedCosmosExport) {
    out.push({
      name: label || 'zigner cosmos',
      data: {
        cosmosAddresses: opts.parsedCosmosExport.addresses,
        cosmosXpub: opts.parsedCosmosExport.xpub,
        publicKey: opts.parsedCosmosExport.publicKey || undefined,
        accountIndex: opts.parsedCosmosExport.accountIndex,
        deviceId: 'cosmos-unknown',
      },
    });
  }

  return out;
}

export async function addPendingZignerWallets(
  adds: PendingZignerAdd[],
  add: (data: ZignerZafuImport, name: string, joinVaultId?: string) => Promise<string>,
): Promise<string | undefined> {
  let joinId: string | undefined;
  for (const item of adds) {
    joinId = await add(item.data, item.name, joinId);
  }
  return joinId;
}
