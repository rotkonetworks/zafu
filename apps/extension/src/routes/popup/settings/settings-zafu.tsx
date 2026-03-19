import { EyeOpenIcon, TrashIcon, ExternalLinkIcon, Link2Icon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { zafuConnectSelector } from '../../../state/zafu';
import { keyRingSelector, type ZafuImport } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Switch } from '@repo/ui/components/ui/switch';
import { useState, useRef, useEffect } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { PagePath } from '../../page/paths';
import { openPageInTab } from '../../../utils/popup-detection';

/** network color for zafu vault badges */
const networkColors: Record<string, string> = {
  penumbra: 'text-purple-500',
  zcash: 'text-yellow-500',
  polkadot: 'text-pink-500',
  cosmos: 'text-pink-500',
  osmosis: 'text-pink-500',
  noble: 'text-pink-500',
  nomic: 'text-pink-500',
  celestia: 'text-pink-500',
};

/**
 * Settings page for Zafu cold wallet integration.
 *
 * Camera permission is requested automatically when user clicks "Scan QR Code".
 * The QrScanner component handles permission prompts and error states.
 */
export const SettingsZafu = () => {
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
    clearZafuState,
  } = useStore(zafuConnectSelector);
  const { addZafuUnencrypted, keyInfos, deleteKeyRing } = useStore(keyRingSelector);

  const [success, setSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingVaultId, setDeletingVaultId] = useState<string | null>(null);
  const [confirmDeleteVault, setConfirmDeleteVault] = useState<string | null>(null);
  const [vaultLegacyMode, setVaultLegacyMode] = useState(false);

  // All zafu vaults from the keyring (single source of truth)
  const zafuVaults = keyInfos.filter(k => k.type === 'zigner-zafu');

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

  // Clear zafu state on unmount
  useEffect(() => {
    return () => {
      clearZafuState();
    };
  }, [clearZafuState]);

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
        // Convert protobuf FVK to base64 for ZafuImport
        const fvkBase64 = btoa(String.fromCharCode(...walletImport.fullViewingKey.inner));
        const zafuData: ZafuImport = {
          fullViewingKey: fvkBase64,
          accountIndex: walletImport.accountIndex,
          deviceId: `penumbra-${Date.now()}`,
        };
        await addZafuUnencrypted(zafuData, walletLabel || walletImport.label);
      } else if (detectedNetwork === 'zcash' && zcashWalletImport) {
        // Convert zcash FVK to string for ZafuImport
        const viewingKey = zcashWalletImport.ufvk
          ?? (zcashWalletImport.orchardFvk
            ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
            : '');
        const zafuData: ZafuImport = {
          viewingKey,
          accountIndex: zcashWalletImport.accountIndex,
          deviceId: `zcash-${Date.now()}`,
        };
        await addZafuUnencrypted(zafuData, walletLabel || zcashWalletImport.label);
      } else if (detectedNetwork === 'cosmos' && parsedCosmosExport) {
        const zafuData: ZafuImport = {
          cosmosAddresses: parsedCosmosExport.addresses,
          publicKey: parsedCosmosExport.publicKey || undefined,
          accountIndex: parsedCosmosExport.accountIndex,
          deviceId: `cosmos-${Date.now()}`,
        };
        await addZafuUnencrypted(zafuData, walletLabel || 'zafu cosmos');
      } else if (detectedNetwork === 'polkadot' && parsedPolkadotExport) {
        const zafuData: ZafuImport = {
          polkadotSs58: parsedPolkadotExport.address,
          polkadotGenesisHash: parsedPolkadotExport.genesisHash,
          accountIndex: 0,
          deviceId: `polkadot-${Date.now()}`,
        };
        await addZafuUnencrypted(zafuData, walletLabel || 'zafu polkadot');
      }

      setSuccess(true);
      clearZafuState();
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
    clearZafuState();
    manualInputRef.current = false;
  };

  const showManualInput = manualInputRef.current && scanState !== 'scanned';
  const showScannedState = scanState === 'scanned' && (walletImport || zcashWalletImport || parsedPolkadotExport || parsedCosmosExport);
  const showInitialState = scanState === 'idle' && !showManualInput;

  return (
    <SettingsScreen title='Zafu Signer'>
      <div className='flex flex-col gap-4'>
        {/* Info Box */}
        <div className='rounded-lg border border-border bg-card-radial p-4'>
          <p className='text-sm text-muted-foreground'>
Zafu Signer is a cold wallet that keeps your spending keys offline. Zafu stores only the
            viewing key to show balances. Transactions require QR code signing with your Zafu Signer
            device.
          </p>
        </div>

        {/* Zafu Wallets — unified list from keyring */}
        {zafuVaults.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-sm font-bold mb-3'>wallets</p>
            <div className='flex flex-col gap-2'>
              {zafuVaults.map(vault => {
                const networks = (vault.insensitive['supportedNetworks'] as string[] | undefined) ?? [];
                const primaryNetwork = networks[0] ?? 'unknown';
                const colorClass = networkColors[primaryNetwork] ?? 'text-muted-foreground';
                const cosmosAddrs = vault.insensitive['cosmosAddresses'] as
                  { chainId: string; address: string; prefix: string }[] | undefined;
                const ss58 = vault.insensitive['polkadotSs58'] as string | undefined;

                return (
                  <div
                    key={vault.id}
                    className='flex items-center justify-between border border-border bg-card-radial p-3'
                  >
                    <div className='flex flex-col gap-1 min-w-0'>
                      <div className='flex items-center gap-2'>
                        <EyeOpenIcon className={`size-4 ${colorClass} flex-shrink-0`} />
                        <span className='text-sm truncate'>{vault.name}</span>
                        {networks.map(n => (
                          <span key={n} className='text-[10px] px-1 bg-muted text-muted-foreground'>
                            {n}
                          </span>
                        ))}
                      </div>
                      {cosmosAddrs?.map(a => (
                        <span key={a.chainId} className='text-[10px] font-mono text-muted-foreground pl-6'>
                          {a.chainId}: {a.address.slice(0, 10)}...{a.address.slice(-6)}
                        </span>
                      ))}
                      {ss58 && (
                        <span className='text-[10px] font-mono text-muted-foreground pl-6'>
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
                        title={keyInfos.length <= 1 ? 'cannot remove the last wallet' : 'remove wallet'}
                      >
                        <TrashIcon className='size-4 text-muted-foreground hover:text-red-400' />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Polkadot Vault Settings */}
        <div className='border-t border-border pt-4'>
          <p className='text-sm font-bold mb-3'>polkadot vault</p>
          <div className='flex flex-col gap-3'>
            <div className='flex items-center justify-between border border-border bg-card-radial p-3'>
              <div className='flex flex-col'>
                <span className='text-sm'>legacy mode</span>
                <span className='text-xs text-muted-foreground'>
                  for older parity signer / polkadot vault devices
                </span>
              </div>
              <Switch
                checked={vaultLegacyMode}
                onCheckedChange={v => void handleVaultLegacyModeChange(v)}
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
                  className='flex items-center gap-1.5 text-xs text-primary hover:underline'
                >
                  <Link2Icon className='size-3' />
                  update metadata at novasama.io
                </a>
              </div>
            )}
          </div>
        </div>

        {/* Success message */}
        {success && (
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400'>
wallet added successfully!
          </div>
        )}

{/* Add Wallet section */}
        <div className='border-t border-border pt-4'>
          <p className='text-sm font-bold mb-3'>add wallet</p>

          {/* Manual input (hidden by default, developer mode) */}
          {showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-xs text-muted-foreground'>
                Developer mode: Paste QR hex data
              </p>

              <Input
                placeholder='Paste QR code hex (530301...)'
                onChange={e => handleManualInput(e.target.value)}
                className='font-mono text-xs'
              />

              <Input
                placeholder='Wallet label (optional)'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}

              <div className='flex gap-2'>
                <Button variant='secondary' className='flex-1' onClick={resetForm}>
                  Cancel
                </Button>
                <Button
                  variant='gradient'
                  className='flex-1'
                  onClick={handleAddWallet}
                  disabled={(!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) || isAdding}
                >
                  {isAdding ? 'Adding...' : 'Add Wallet'}
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
                  <span className='text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground'>
                    {detectedNetwork}
                  </span>
                </div>
                <p className='text-xs text-muted-foreground mt-1'>
                  {parsedCosmosExport ? (
                    <span className='font-mono'>
                      {parsedCosmosExport.addresses.map(a => a.address.slice(0, 10)).join(', ')}...
                    </span>
                  ) : parsedPolkadotExport ? (
                    <span className='font-mono'>
                      {parsedPolkadotExport.address.slice(0, 8)}...{parsedPolkadotExport.address.slice(-6)}
                    </span>
                  ) : (
                    <>
                      account #{walletImport?.accountIndex ?? zcashWalletImport?.accountIndex ?? 0}
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
                placeholder='Wallet label (optional)'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              {errorMessage && <p className='text-xs text-red-400'>{errorMessage}</p>}

              <div className='flex gap-2'>
                <Button variant='secondary' className='flex-1' onClick={resetForm}>
                  Cancel
                </Button>
                <Button
                  variant='gradient'
                  className='flex-1'
                  onClick={handleAddWallet}
                  disabled={isAdding}
                >
                  {isAdding ? 'Adding...' : 'Add Wallet'}
                </Button>
              </div>
            </div>
          )}

          {/* Initial state - show scan button */}
          {showInitialState && (
            <div className='flex flex-col gap-2'>
              {/* Always open scanner in new tab for better camera experience */}
              <p className='text-xs text-muted-foreground text-center mb-2'>
                Opens camera in a new tab for scanning
              </p>
              <Button
                variant='secondary'
                className='w-full'
                onClick={() => openPageInTab(PagePath.IMPORT_ZAFU)}
              >
                <ExternalLinkIcon className='size-4 mr-2' />
                Scan QR Code
              </Button>
              {errorMessage && <p className='text-xs text-red-400 text-center'>{errorMessage}</p>}
            </div>
          )}

          {/* Error state */}
          {scanState === 'error' && !showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-sm text-red-400'>{errorMessage}</p>
              <Button variant='secondary' onClick={resetForm}>
                Try Again
              </Button>
            </div>
          )}
        </div>
      </div>
    </SettingsScreen>
  );
};
