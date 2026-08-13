/**
 * wallet-entries — side-effectful wallet record creation
 *
 * these functions write to chrome storage (local.set) to create
 * per-network wallet records linked to a vault. no zustand state updates.
 */

import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import type { NetworkType, ZignerZafuImport, LedgerImport } from './types';
import type { ZcashWalletJson } from '../wallets';
import type { Key } from '@repo/encryption/key';

/** create penumbra wallet entry for a mnemonic vault (side effect: local.set) */
export async function createPenumbraWalletForMnemonic(
  mnemonic: string,
  name: string,
  vaultId: string,
  key: Key,
  local: ExtensionStorage<LocalStorageState>,
): Promise<void> {
  const { generateSpendKey, getFullViewingKey, getWalletId } =
    await import('@rotko/penumbra-wasm/keys');
  const spendKey = await generateSpendKey(mnemonic);
  const fullViewingKey = await getFullViewingKey(spendKey);
  const walletId = await getWalletId(fullViewingKey);

  const encryptedSeedPhrase = await key.seal(mnemonic);
  const praxWallet = {
    id: walletId.toJsonString(),
    label: name,
    fullViewingKey: fullViewingKey.toJsonString(),
    custody: { encryptedSeedPhrase: encryptedSeedPhrase.toJson() },
    vaultId,
  };

  const wallets = (await local.get('penumbraWallets')) ?? [];
  await local.set('penumbraWallets', [praxWallet, ...wallets]);
  await local.set('activeWalletIndex', 0);
}

/** create wallet entries (penumbra + zcash) for a zigner import (side effect: local.set) */
export async function createZignerWalletEntries(
  data: ZignerZafuImport,
  name: string,
  key: Key,
  vaultId: string,
  supportedNetworks: string[],
  existingVaultCount: number,
  local: ExtensionStorage<LocalStorageState>,
): Promise<NetworkType[]> {
  if (data.fullViewingKey) {
    try {
      const { FullViewingKey } =
        await import('@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb');
      const { getWalletId } = await import('@rotko/penumbra-wasm/keys');

      const fvkBytes = Uint8Array.from(atob(data.fullViewingKey), c => c.charCodeAt(0));
      const fvk = new FullViewingKey({ inner: fvkBytes });
      const walletId = await getWalletId(fvk);

      const metadata = JSON.stringify({
        accountIndex: data.accountIndex,
        importedAt: Date.now(),
        signerType: 'zigner',
      });
      const metadataBox = await key.seal(metadata);

      const praxWallet = {
        id: walletId.toJsonString(),
        label: name,
        fullViewingKey: fvk.toJsonString(),
        custody: { airgapSigner: metadataBox.toJson() },
        vaultId,
      };

      const existingWallets = (await local.get('penumbraWallets')) ?? [];
      await local.set('penumbraWallets', [praxWallet, ...existingWallets]);
      await local.set('activeWalletIndex', 0);
    } catch (e) {
      console.warn('[keyring] failed to create penumbra wallet entry for zigner:', e);
    }
  }

  if (data.viewingKey) {
    // Cryptographic UFVK gate at the persistence boundary. The pure
    // `@repo/wallet` parser only does structural pre-screening (HRP /
    // charset / length) to stay wasm-free; this is where we run the
    // authoritative `zcash_keys::UnifiedFullViewingKey::decode` (same
    // decoder the signing path uses) before a wallet record touches
    // encrypted storage. Only applies to unified strings (`uview1...` from
    // UR imports); the legacy binary zigner path supplies a raw base64
    // orchard FVK, which is not a unified string and must skip this.
    if (data.viewingKey.startsWith('uview')) {
      const zwasm = (await import('@repo/zcash-wasm')) as unknown as {
        default?: (opts?: { module_or_path?: string }) => Promise<unknown>;
        validate_ufvk: (s: string) => boolean;
      };
      if (typeof zwasm.default === 'function') {
        await zwasm.default();
      }
      if (!zwasm.validate_ufvk(data.viewingKey)) {
        // Throw, don't swallow: a bogus UFVK must fail the import here,
        // loudly, not get silently dropped and rediscovered at first send
        // (and not poison FVK-equality dedup with garbage).
        throw new Error(
          'UFVK failed cryptographic validation — refusing to import. ' +
            'The scanned viewing key is structurally plausible but does not ' +
            'decode as a valid Zcash Unified FVK.',
        );
      }
    }
    try {
      const existingZcashWallets = (await local.get('zcashWallets')) ?? [];
      const zcashWallet = {
        id: `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        label: name,
        orchardFvk: data.viewingKey,
        address: '',
        accountIndex: data.accountIndex,
        mainnet: !data.viewingKey.startsWith('uviewtest'),
        vaultId,
        // Defaults to 'zigner' when omitted on the import side. Keystone
        // imports flow through the same path and set this explicitly so the
        // signing UI can hide Penumbra/FROST/ZID affordances.
        coldSignerType: data.coldSignerType ?? 'zigner',
      };
      await local.set('zcashWallets', [zcashWallet, ...existingZcashWallets]);
      await local.set('activeZcashIndex', 0);
    } catch (e) {
      console.warn('[keyring] failed to create zcash wallet entry for zigner:', e);
    }
  }

  const currentEnabled = await local.get('enabledNetworks');
  const networkSet = new Set<string>(currentEnabled ?? []);
  for (const network of supportedNetworks) {
    networkSet.add(network);
  }
  const newEnabledNetworks = [...networkSet] as NetworkType[];
  await local.set('enabledNetworks', newEnabledNetworks);

  if (existingVaultCount === 0 && supportedNetworks.length > 0) {
    await local.set('activeNetwork', supportedNetworks[0] as NetworkType);
  }

  return newEnabledNetworks;
}

/**
 * create the zcash wallet entry for a Ledger cold-signer import (side effect:
 * local.set). clone of the zcash branch of createZignerWalletEntries, trimmed to
 * zcash-only single-signer — no penumbra FVK, no polkadot/cosmos, no ZID.
 *
 * `key` is accepted for signature parity with createZignerWalletEntries (and so
 * future device-metadata sealing can slot in) but is currently unused: a Ledger
 * account stores no secret material, only a watch-only ufvk/address.
 */
export async function assertLedgerUfvkValid(ufvk: string | undefined): Promise<void> {
  // Cryptographic UFVK gate — same authoritative decoder the signing path uses.
  // Only unified strings (`uview1…`) are validated; a Ledger export is always a
  // unified string when present.
  //
  // MUST run before any storage write: an invalid UFVK that is only caught
  // after the vault has been persisted leaves a selected vault with no wallet
  // record behind it (a half-initialised keyring the user cannot use or
  // obviously delete).
  if (!ufvk || !ufvk.startsWith('uview')) {
    return;
  }
  const zwasm = (await import('@repo/zcash-wasm')) as unknown as {
    default?: (opts?: { module_or_path?: string }) => Promise<unknown>;
    validate_ufvk: (s: string) => boolean;
  };
  if (typeof zwasm.default === 'function') {
    await zwasm.default();
  }
  if (!zwasm.validate_ufvk(ufvk)) {
    throw new Error(
      'UFVK failed cryptographic validation — refusing to import. ' +
        'The Ledger-exported viewing key is structurally plausible but does ' +
        'not decode as a valid Zcash Unified FVK.',
    );
  }
}

export async function createLedgerWalletEntries(
  data: LedgerImport,
  name: string,
  _key: Key,
  vaultId: string,
  existingVaultCount: number,
  local: ExtensionStorage<LocalStorageState>,
): Promise<NetworkType[]> {
  // Defence in depth: the caller validates before writing the vault, this
  // re-checks at the persistence boundary. Cheap - the wasm module is cached.
  await assertLedgerUfvkValid(data.ufvk);

  {
    const existingZcashWallets = (await local.get('zcashWallets')) ?? [];
    const zcashWallet = {
      id: `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      label: name,
      // orchardFvk is a required field; a Ledger import stores its UFVK in the
      // dedicated `ufvk` field, so leave orchardFvk empty. use-address's
      // watch-only branch reads `ufvk` first, so address/balance derive free
      // when a ufvk is present.
      orchardFvk: '',
      ...(data.ufvk ? { ufvk: data.ufvk } : {}),
      // If a ufvk is present, address derives free from it; otherwise store the
      // address directly. NOTE: without a ufvk there is no shielded scanning —
      // balances/notes require the UFVK to be provided later.
      address: data.address,
      // Transparent Ledger (hw-app-btc) account: persist the t-address so the
      // send flow can fetch UTXOs / route change without a device round-trip and
      // the receive screen can show it.
      ...(data.transparentAddress ? { transparentAddress: data.transparentAddress } : {}),
      accountIndex: data.accountIndex,
      mainnet: data.mainnet,
      vaultId,
      // 'ledger' is now in the persisted v2 storage schema's coldSignerType union
      // (widened alongside this Ledger work). The value is the ColdSignerType
      // source of truth.
      coldSignerType: 'ledger' as const,
    };
    // NOT wrapped in a try/catch: a swallowed failure here would leave a vault
    // the UI presents as a Ledger wallet with no zcash wallet record behind it.
    // Let it propagate so the caller can roll the vault back.
    await local.set('zcashWallets', [zcashWallet, ...existingZcashWallets]);
    await local.set('activeZcashIndex', 0);
  }

  const currentEnabled = await local.get('enabledNetworks');
  const networkSet = new Set<string>(currentEnabled ?? []);
  networkSet.add('zcash');
  const newEnabledNetworks = [...networkSet] as NetworkType[];
  await local.set('enabledNetworks', newEnabledNetworks);

  if (existingVaultCount === 0) {
    await local.set('activeNetwork', 'zcash' as NetworkType);
  }

  return newEnabledNetworks;
}

/** remove all wallet records linked to a vaultId (side effect: local.set + worker cleanup) */
export async function removeLinkedWallets(
  vaultId: string,
  local: ExtensionStorage<LocalStorageState>,
): Promise<{ removedZcashIds: string[] }> {
  // penumbra wallets
  const wallets = (await local.get('penumbraWallets')) ?? [];
  const updatedWallets = wallets.filter((w: { vaultId?: string }) => w.vaultId !== vaultId);
  if (updatedWallets.length !== wallets.length) {
    await local.set('penumbraWallets', updatedWallets);
    const activeWalletIndex = (await local.get('activeWalletIndex')) ?? 0;
    if (activeWalletIndex >= updatedWallets.length) {
      await local.set('activeWalletIndex', Math.max(0, updatedWallets.length - 1));
    }
  }

  // zcash wallets
  const zcashWallets = ((await local.get('zcashWallets')) ?? []) as ZcashWalletJson[];
  const removedZcash = zcashWallets.filter(w => w.vaultId === vaultId);
  const updatedZcash = zcashWallets.filter(w => w.vaultId !== vaultId);
  if (updatedZcash.length !== zcashWallets.length) {
    await local.set('zcashWallets', updatedZcash);
    const activeZcashIndex = (await local.get('activeZcashIndex')) ?? 0;
    if (activeZcashIndex >= updatedZcash.length) {
      await local.set('activeZcashIndex', Math.max(0, updatedZcash.length - 1));
    }
  }

  return { removedZcashIds: removedZcash.map(w => w.id) };
}

/** clean up zcash worker data + birthday key for a vault */
export async function cleanupZcashData(vaultId: string, removedZcashIds: string[]): Promise<void> {
  for (const id of removedZcashIds) {
    try {
      const { deleteWalletInWorker } = await import('./network-worker');
      await deleteWalletInWorker('zcash', id);
    } catch {
      // worker may not be running
    }
  }
  try {
    await chrome.storage.local.remove(`zcashBirthday_${vaultId}`);
  } catch {}
}

/**
 * Keys that SURVIVE a nuke.
 *
 * This list is deliberately tiny, and it is a deny-list rather than an
 * allow-list of things to delete. That inversion is the whole point of the
 * rewrite below: the previous implementation enumerated the keys it wanted
 * gone, which meant every key added to storage afterwards was retained by
 * default and silently accumulated. It left behind, among others, the ZID
 * share log (which sites you authenticated to, and when), the ZID pins and
 * generation keys, site labels, known sites, the password key print, the
 * diversified-address referral graph, the contacts and messages ciphertext,
 * and `zignerWallets` — which stores Penumbra and Zcash full viewing keys in
 * PLAINTEXT, i.e. a complete, permanent read capability over the user's
 * transaction history, surviving the deletion of the wallet that owned it.
 *
 * A user who deletes their last vault is very plausibly doing it under
 * duress or before handing over a device. Retaining any of that is a
 * physical-safety problem, not a tidiness problem. So: everything goes
 * unless it appears here, and nothing that identifies a person, a wallet, a
 * counterparty or a site may be added to this list.
 */
const NUKE_SURVIVORS: ReadonlySet<string> = new Set<string>([
  // pure appearance / ergonomics. carry no identity and no history.
  'zafuTheme',
  'zafuFont',
  'autoLockMinutes',
]);

/** delete an IndexedDB database, resolving even if the delete is blocked. */
const deleteDatabaseAwaitable = (name: string): Promise<void> =>
  new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => {
      console.warn('[nuke] IDB delete failed:', name, req.error);
      resolve();
    };
    // An open connection blocks the delete SILENTLY — the request simply
    // never completes. Surfacing it is the difference between "the data is
    // gone" and "we think the data is gone".
    req.onblocked = () => {
      console.error('[nuke] IDB delete BLOCKED (data NOT deleted):', name);
      resolve();
    };
  });

/**
 * nuke all wallet data — called when the last vault is deleted.
 *
 * Terminates the sync workers FIRST. `indexedDB.deleteDatabase` against a
 * database that still has an open connection does not fail; it fires
 * `onblocked` and hangs, so a delete issued while the zcash worker holds
 * `zafu-zcash` open was a no-op that looked like a success.
 */
export async function nukeAllWalletData(
  session: ExtensionStorage<SessionStorageState>,
  local: ExtensionStorage<LocalStorageState>,
): Promise<void> {
  await session.remove('passwordKey');

  // drop worker-held IDB connections before attempting any delete
  try {
    const { terminateNetworkWorker } = await import('./network-worker');
    terminateNetworkWorker('zcash');
    terminateNetworkWorker('penumbra');
  } catch {
    // workers may not be running
  }

  const allLocalKeys = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(allLocalKeys).filter(k => !NUKE_SURVIVORS.has(k));
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  // session storage holds decrypted material for the unlocked wallet
  try {
    await chrome.storage.session.clear();
  } catch {}

  // Delete every IndexedDB in this origin. Naming a fixed list here has the
  // same rot problem as the old key allow-list: `viewdata/penumbra/*` is
  // created per wallet id, so no static list can cover it. Every database in
  // the extension origin is ours, so enumerate and remove all of them.
  try {
    const dbs = await indexedDB.databases();
    const names = dbs.map(d => d.name).filter((n): n is string => !!n);
    await Promise.all(names.map(deleteDatabaseAwaitable));
  } catch (e) {
    console.warn('[nuke] IDB enumeration failed, falling back to known names:', e);
    await deleteDatabaseAwaitable('zafu-zcash');
  }

  // The bulk remove above already deleted these. Re-setting the wallet lists
  // is not just redundant, it is impossible: `local` is the encrypting proxy
  // and the session key was dropped at the top of this function, so the
  // writes would no-op with a "wallet is locked" warning. Only the plaintext
  // index keys are restored, so the store hydrates to a clean empty state.
  await local.set('selectedVaultId', undefined);
  await local.set('activeWalletIndex', 0);
  await local.set('activeZcashIndex', 0);
}
