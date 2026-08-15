import { EyeOpenIcon, TrashIcon, ExternalLinkIcon, Link2Icon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { zignerConnectSelector } from '../../../state/zigner';
import { keyRingSelector, type ZignerZafuImport } from '../../../state/keyring';
import { isPro } from '../../../state/license';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { ToggleSwitch } from '../../../components/toggle-switch';
import { useState, useRef, useEffect } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { PagePath } from '../../page/paths';
import { openPageInTab } from '../../../utils/popup-detection';
import { ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';
import { describeZcashHeight } from '../../../utils/zcash-blocks';
import { cn } from '@repo/ui/lib/utils';

/** network color for zigner vault badges */
const networkColors: Record<string, string> = {
  penumbra: 'text-purple-500',
  zcash: 'text-yellow-500',
  polkadot: 'text-pink-500',
  cosmos: 'text-pink-500',
  noble: 'text-pink-500',
  cosmoshub: 'text-indigo-500',
};

/**
 * Settings page for Zigner cold wallet integration.
 *
 * Camera permission is requested automatically when user clicks "Scan QR Code".
 * The QrScanner component handles permission prompts and error states.
 */
export const SettingsZigner = () => {
  const pro = useStore(isPro);
  const {
    scanState,
    walletLabel,
    walletImport,
    zcashWalletImport,
    parsedPolkadotExport,
    parsedCosmosExport,
    detectedNetwork,
    errorMessage,
    processQrData,
    setWalletLabel,
    setError,
    clearZignerState,
  } = useStore(zignerConnectSelector);
  const { addZignerUnencrypted, keyInfos, deleteKeyRing } = useStore(keyRingSelector);

  const [success, setSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingVaultId, setDeletingVaultId] = useState<string | null>(null);
  const [confirmDeleteVault, setConfirmDeleteVault] = useState<string | null>(null);
  const [vaultLegacyMode, setVaultLegacyMode] = useState(false);
  // optional zcash start block (birthday) entered at import time. blank = sync
  // from near the chain tip. Stored per-vault as zcashBirthday_<vaultId>.
  const [startBlock, setStartBlock] = useState<string>('');

  const startBlockNum = parseInt(startBlock, 10);
  const startBlockValid = !isNaN(startBlockNum) && startBlockNum >= ZCASH_ORCHARD_ACTIVATION;
  const startBlockHint = startBlock.trim() ? describeZcashHeight(startBlockNum) : null;

  // All zigner vaults from the keyring (single source of truth)
  const zignerVaults = keyInfos.filter(k => k.type === 'zigner-zafu');

  // Hidden paste mode - activated by clicking icon 10 times
  const manualInputRef = useRef(false);

  // Load polkadot vault settings
  useEffect(() => {
    void localExtStorage.get('polkadotVaultSettings').then(settings => {
      setVaultLegacyMode(settings?.legacyMode ?? false);
    });
  }, []);

  const handleVaultLegacyModeChange = async (enabled: boolean) => {
    setVaultLegacyMode(enabled);
    await localExtStorage.set('polkadotVaultSettings', { legacyMode: enabled });
  };

  // Clear zigner state on unmount
  useEffect(() => {
    return () => {
      clearZignerState();
    };
  }, [clearZignerState]);

  const handleManualInput = (value: string) => {
    if (value.trim()) {
      processQrData(value);
    }
  };

  const handleDeleteVault = async (vaultId: string) => {
    try {
      setDeletingVaultId(vaultId);
      await deleteKeyRing(vaultId);
      setConfirmDeleteVault(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to remove wallet: ${message}`);
    } finally {
      setDeletingVaultId(null);
    }
  };

  const handleAddWallet = async () => {
    if (!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) {
      setError('please scan a qr code first');
      return;
    }

    try {
      setIsAdding(true);

      if (detectedNetwork === 'penumbra' && walletImport) {
        // Convert protobuf FVK to base64 for ZignerZafuImport
        const fvkBase64 = btoa(String.fromCharCode(...walletImport.fullViewingKey.inner));
        const zignerData: ZignerZafuImport = {
          fullViewingKey: fvkBase64,
          accountIndex: walletImport.accountIndex,
          deviceId: walletImport.zidPublicKey ?? `penumbra-${Date.now()}`,
          zidPublicKey: walletImport.zidPublicKey,
        };
        await addZignerUnencrypted(zignerData, walletLabel || walletImport.label);
      } else if (detectedNetwork === 'zcash' && zcashWalletImport) {
        // Convert zcash FVK to string for ZignerZafuImport
        const viewingKey =
          zcashWalletImport.ufvk ??
          (zcashWalletImport.orchardFvk
            ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
            : '');
        const zignerData: ZignerZafuImport = {
          viewingKey,
          accountIndex: zcashWalletImport.accountIndex,
          deviceId: zcashWalletImport.zidPublicKey ?? `zcash-${Date.now()}`,
          zidPublicKey: zcashWalletImport.zidPublicKey,
        };
        const vaultId = await addZignerUnencrypted(
          zignerData,
          walletLabel || zcashWalletImport.label,
        );
        // persist an explicitly-entered start block as the wallet birthday, so an
        // older cold wallet doesn't silently start syncing near the chain tip
        // (which would hide every pre-existing shielded note).
        if (startBlock.trim() !== '' && startBlockValid) {
          const clamped = Math.max(ZCASH_ORCHARD_ACTIVATION, startBlockNum);
          await chrome.storage.local.set({ [`zcashBirthday_${vaultId}`]: clamped });
        }
      } else if (detectedNetwork === 'cosmos' && parsedCosmosExport) {
        const zignerData: ZignerZafuImport = {
          cosmosAddresses: parsedCosmosExport.addresses,
          publicKey: parsedCosmosExport.publicKey || undefined,
          accountIndex: parsedCosmosExport.accountIndex,
          deviceId: `cosmos-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner cosmos');
      } else if (detectedNetwork === 'polkadot' && parsedPolkadotExport) {
        const zignerData: ZignerZafuImport = {
          polkadotSs58: parsedPolkadotExport.address,
          polkadotGenesisHash: parsedPolkadotExport.genesisHash,
          accountIndex: 0,
          deviceId: `polkadot-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner polkadot');
      }

      setSuccess(true);
      clearZignerState();
      setStartBlock('');
      manualInputRef.current = false;

      setTimeout(() => setSuccess(false), 3000);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`failed to add wallet: ${message}`);
    } finally {
      setIsAdding(false);
    }
  };

  const resetForm = () => {
    clearZignerState();
    manualInputRef.current = false;
  };

  const showManualInput = manualInputRef.current && scanState !== 'scanned';
  const showScannedState =
    scanState === 'scanned' &&
    (walletImport || zcashWalletImport || parsedPolkadotExport || parsedCosmosExport);
  const showInitialState = scanState === 'idle' && !showManualInput;

  return (
    <SettingsScreen title='zafu zigner'>
      <div className='flex flex-col gap-4'>
        {/* Info Box */}
        <div className='rounded-md border border-border-soft bg-elev-1 p-4'>
          <p className='text-xs text-fg'>cold wallet - keeps spending keys offline, sign by QR.</p>
        </div>

        {/* Cold-signing value prop, shown when no zigner is paired yet - markets
            the air-gapped signer itself (security), not a subscription. */}
        {zignerVaults.length === 0 && (
          <div className='rounded-md border border-zigner-gold/30 bg-zigner-gold/5 p-4 flex flex-col gap-3'>
            <div className='flex items-start gap-3'>
              <span className='i-ph-shield-check size-5 text-zigner-gold shrink-0 mt-0.5' />
              <div className='flex flex-col gap-2'>
                <p className='text-data text-fg-high lowercase'>keep your keys off this device</p>
                <p className='text-xs text-fg-muted'>
                  pair a zigner air-gapped signer - your spending keys never touch a networked
                  device, and you approve each transaction by scanning a QR.
                </p>
              </div>
            </div>
            <div className='flex gap-2'>
              <Button
                size='sm'
                onClick={() => openPageInTab(PagePath.IMPORT_ZIGNER)}
                title='scan the pairing QR from your zigner'
              >
                pair zigner
              </Button>
              <Button
                variant='secondary'
                size='sm'
                onClick={() =>
                  window.open('https://zigner.zafu.pro', '_blank', 'noopener,noreferrer')
                }
              >
                get zigner
              </Button>
            </div>
          </div>
        )}

        {/* Zigner Wallets — unified list from keyring (visible to all users) */}
        {zignerVaults.length > 0 && (
          <div className='border-t border-border-soft pt-4'>
            <div className='mb-3 flex items-center justify-between'>
              <p className='kicker'>wallets</p>
              <button
                type='button'
                onClick={() => openPageInTab(PagePath.IMPORT_ZIGNER)}
                className='text-label text-zigner-gold hover:underline underline-offset-2 lowercase'
                title='scan the pairing QR from another zigner'
              >
                + pair another
              </button>
            </div>
            <div className='flex flex-col gap-2'>
              {zignerVaults.map(vault => {
                const networks =
                  (vault.insensitive['supportedNetworks'] as string[] | undefined) ?? [];
                const primaryNetwork = networks[0] ?? 'unknown';
                const colorClass = networkColors[primaryNetwork] ?? 'text-fg-muted';
                const cosmosAddrs = vault.insensitive['cosmosAddresses'] as
                  | { chainId: string; address: string; prefix: string }[]
                  | undefined;
                const ss58 = vault.insensitive['polkadotSs58'] as string | undefined;

                return (
                  <div
                    key={vault.id}
                    className='flex items-center justify-between rounded-md border border-border-soft bg-elev-1 p-3'
                  >
                    <div className='flex flex-col gap-2 min-w-0'>
                      <div className='flex items-center gap-2'>
                        <EyeOpenIcon className={`size-4 ${colorClass} flex-shrink-0`} />
                        <span className='text-data text-fg-high truncate'>{vault.name}</span>
                        {networks.map(n => (
                          <span
                            key={n}
                            className='rounded-sm text-label px-1 bg-elev-2 text-fg-dim lowercase'
                          >
                            {n}
                          </span>
                        ))}
                      </div>
                      {cosmosAddrs?.map(a => (
                        <span key={a.chainId} className='text-label tabular text-fg-muted pl-6'>
                          {a.chainId}: {a.address.slice(0, 10)}...{a.address.slice(-6)}
                        </span>
                      ))}
                      {ss58 && (
                        <span className='text-label tabular text-fg-muted pl-6'>
                          {ss58.slice(0, 8)}...{ss58.slice(-6)}
                        </span>
                      )}
                    </div>

                    {confirmDeleteVault === vault.id ? (
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='destructive'
                          size='sm'
                          onClick={() => void handleDeleteVault(vault.id)}
                          disabled={deletingVaultId === vault.id}
                        >
                          {deletingVaultId === vault.id ? 'removing...' : 'confirm'}
                        </Button>
                        <Button
                          variant='secondary'
                          size='sm'
                          onClick={() => setConfirmDeleteVault(null)}
                          disabled={deletingVaultId === vault.id}
                        >
                          cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => setConfirmDeleteVault(vault.id)}
                        disabled={keyInfos.length <= 1}
                        title={
                          keyInfos.length <= 1 ? 'cannot remove the last wallet' : 'remove wallet'
                        }
                      >
                        <TrashIcon className='size-4 text-fg-muted hover:text-red-400' />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Polkadot Vault Settings */}
        {pro && (
          <div className='border-t border-border-hard pt-4'>
            <p className='text-sm font-bold mb-3'>polkadot vault</p>
            <div className='flex flex-col gap-3'>
              <div className='flex items-center justify-between border border-border-hard bg-elev-2 p-3'>
                <div className='flex flex-col'>
                  <span className='text-sm'>legacy mode</span>
                  <span className='text-xs text-fg-muted'>
                    for older parity signer / polkadot vault devices
                  </span>
                </div>
                <ToggleSwitch
                  checked={vaultLegacyMode}
                  onChange={v => void handleVaultLegacyModeChange(v)}
                  label='legacy mode'
                />
              </div>

              {vaultLegacyMode && (
                <div className='border border-yellow-500/30 bg-yellow-500/10 p-3'>
                  <p className='text-xs text-yellow-400 mb-2'>
                    legacy mode requires up-to-date metadata on your device
                  </p>
                  <a
                    href='https://metadata.novasama.io/'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-2 text-xs text-zigner-gold hover:underline'
                  >
                    <Link2Icon className='size-3' />
                    update metadata at novasama.io
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Success message */}
        {pro && success && (
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400'>
            wallet added successfully!
          </div>
        )}

        {/* Add Wallet section */}
        {pro && (
          <div className='border-t border-border-hard pt-4'>
            <p className='text-sm font-bold mb-3'>add wallet</p>

            {/* Manual input (hidden by default, developer mode) */}
            {showManualInput && (
              <div className='flex flex-col gap-3'>
                <p className='text-xs text-fg-muted'>developer mode: paste QR hex data</p>

                <Input
                  placeholder='paste QR code hex (530301...)'
                  onChange={e => handleManualInput(e.target.value)}
                  className='font-mono text-xs'
                />

                <Input
                  placeholder='wallet label (optional)'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                />

                {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}

                <div className='flex gap-2'>
                  <Button variant='secondary' className='flex-1' onClick={resetForm}>
                    cancel
                  </Button>
                  <Button
                    variant='gradient'
                    className='flex-1'
                    onClick={handleAddWallet}
                    disabled={
                      (!walletImport &&
                        !zcashWalletImport &&
                        !parsedPolkadotExport &&
                        !parsedCosmosExport) ||
                      isAdding
                    }
                  >
                    {isAdding ? 'adding...' : 'add wallet'}
                  </Button>
                </div>
              </div>
            )}

            {/* Scanned QR - ready to add */}
            {showScannedState && (
              <div className='flex flex-col gap-3'>
                <div className='border border-green-500/30 bg-green-500/10 p-3'>
                  <div className='flex items-center gap-2'>
                    <p className='text-sm font-medium text-green-400'>qr code scanned</p>
                    <span className='text-label px-1.5 py-0.5 bg-elev-2 text-fg-muted'>
                      {detectedNetwork}
                    </span>
                  </div>
                  <p className='text-xs text-fg-muted mt-1'>
                    {parsedCosmosExport ? (
                      <span className='font-mono'>
                        {parsedCosmosExport.addresses.map(a => a.address.slice(0, 10)).join(', ')}
                        ...
                      </span>
                    ) : parsedPolkadotExport ? (
                      <span className='font-mono'>
                        {parsedPolkadotExport.address.slice(0, 8)}...
                        {parsedPolkadotExport.address.slice(-6)}
                      </span>
                    ) : (
                      <>
                        account #
                        {walletImport?.accountIndex ?? zcashWalletImport?.accountIndex ?? 0}
                        {zcashWalletImport && (
                          <span className='ml-2'>
                            {zcashWalletImport.mainnet ? 'mainnet' : 'testnet'}
                          </span>
                        )}
                      </>
                    )}
                  </p>
                </div>

                <Input
                  placeholder='wallet label (optional)'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                />

                {detectedNetwork === 'zcash' && (
                  <div className='flex flex-col gap-1'>
                    <label className='text-label text-fg-muted'>
                      start block (optional) — blank syncs from near the chain tip
                    </label>
                    <Input
                      type='text'
                      inputMode='numeric'
                      placeholder='e.g. 2910104'
                      value={startBlock}
                      onChange={e => setStartBlock(e.target.value)}
                      className='font-mono text-xs'
                    />
                    {startBlockHint && (
                      <p
                        className={cn(
                          'text-label',
                          startBlockHint.ok ? 'text-fg-dim' : 'text-hanko',
                        )}
                      >
                        {startBlockHint.text}
                      </p>
                    )}
                  </div>
                )}

                {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}

                <div className='flex gap-2'>
                  <Button variant='secondary' className='flex-1' onClick={resetForm}>
                    cancel
                  </Button>
                  <Button
                    variant='gradient'
                    className='flex-1'
                    onClick={handleAddWallet}
                    disabled={isAdding}
                  >
                    {isAdding ? 'adding...' : 'add wallet'}
                  </Button>
                </div>
              </div>
            )}

            {/* Initial state - show scan button */}
            {showInitialState && (
              <div className='flex flex-col gap-2'>
                {/* Always open scanner in new tab for better camera experience */}
                <p className='text-xs text-fg-muted text-center mb-2'>
                  opens camera in a new tab for scanning
                </p>
                <Button
                  variant='secondary'
                  className='w-full'
                  onClick={() => openPageInTab(PagePath.IMPORT_ZIGNER)}
                >
                  <ExternalLinkIcon className='size-4 mr-2' />
                  scan QR code
                </Button>
                {errorMessage && <p className='text-xs text-red-400 text-center'>{errorMessage}</p>}
              </div>
            )}

            {/* Error state */}
            {scanState === 'error' && !showManualInput && (
              <div className='flex flex-col gap-3'>
                <p className='text-sm text-red-400'>{errorMessage}</p>
                <Button variant='secondary' onClick={resetForm}>
                  try again
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </SettingsScreen>
  );
};
