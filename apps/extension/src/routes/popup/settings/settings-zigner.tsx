import { EyeOpenIcon, TrashIcon, ExternalLinkIcon, Link2Icon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { walletsSelector } from '../../../state/wallets';
import { zignerConnectSelector } from '../../../state/zigner';
import { keyRingSelector, type ZignerZafuImport } from '../../../state/keyring';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { Switch } from '@repo/ui/components/ui/switch';
import { useState, useRef, useEffect } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { PagePath } from '../../page/paths';
import { openPageInTab } from '../../../utils/popup-detection';

/** Check if a wallet custody is watch-only (Zigner) */
function isZignerWallet(custody: { encryptedSeedPhrase?: unknown; airgapSigner?: unknown }): boolean {
  return 'airgapSigner' in custody;
}

/**
 * Settings page for Zigner cold wallet integration.
 *
 * Camera permission is requested automatically when user clicks "Scan QR Code".
 * The QrScanner component handles permission prompts and error states.
 */
export const SettingsZigner = () => {
  const { all, zcashWallets, addAirgapSignerWallet, addZcashWallet, removeWallet, removeZcashWallet } = useStore(walletsSelector);
  const {
    scanState,
    walletLabel,
    walletImport,
    zcashWalletImport,
    parsedPolkadotExport,
    detectedNetwork,
    errorMessage,
    processQrData,
    setWalletLabel,
    setScanState,
    setError,
    clearZignerState,
  } = useStore(zignerConnectSelector);
  const { addZignerUnencrypted } = useStore(keyRingSelector);

  const [success, setSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [vaultLegacyMode, setVaultLegacyMode] = useState(false);

  // Get list of Zigner wallets with their indices
  const zignerWallets = all
    .map((wallet, index) => ({ wallet, index }))
    .filter(({ wallet }) => isZignerWallet(wallet.custody));

  // Hidden paste mode - activated by clicking icon 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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

  const handleIconClick = () => {
    clickCountRef.current += 1;

    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
    }
    clickTimeoutRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, 3000);

    if (clickCountRef.current >= 10) {
      manualInputRef.current = true;
      setScanState('idle');
      clickCountRef.current = 0;
    }
  };

  const handleManualInput = (value: string) => {
    if (value.trim()) {
      processQrData(value);
    }
  };

  const handleAddWallet = async () => {
    if (!walletImport && !zcashWalletImport && !parsedPolkadotExport) {
      setError('please scan a qr code first');
      return;
    }

    try {
      setIsAdding(true);

      if (detectedNetwork === 'penumbra' && walletImport) {
        await addAirgapSignerWallet(walletImport);
      } else if (detectedNetwork === 'zcash' && zcashWalletImport) {
        await addZcashWallet(zcashWalletImport);
      } else if (detectedNetwork === 'polkadot' && parsedPolkadotExport) {
        // polkadot zigner import - watch-only address via keyring
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

  const handleDeleteWallet = async (index: number) => {
    try {
      setDeletingIndex(index);
      await removeWallet(index);
      setConfirmDelete(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to remove wallet: ${message}`);
    } finally {
      setDeletingIndex(null);
    }
  };

  const showManualInput = manualInputRef.current && scanState !== 'scanned';
  const showScannedState = scanState === 'scanned' && (walletImport || zcashWalletImport || parsedPolkadotExport);
  const showInitialState = scanState === 'idle' && !showManualInput;

  return (
    <SettingsScreen
title='Zafu Zigner'
      IconComponent={() => (
        <div onClick={handleIconClick}>
          <EyeOpenIcon className='size-5' />
        </div>
      )}
    >
      <div className='flex flex-col gap-4'>
        {/* Info Box */}
        <div className='rounded-lg border border-border bg-card-radial p-4'>
          <p className='text-sm text-muted-foreground'>
Zafu Zigner is a cold wallet that keeps your spending keys offline. Zafu stores only the
            viewing key to show balances. Transactions require QR code signing with your Zafu Zigner
            device.
          </p>
        </div>

        {/* Existing Penumbra Zigner Wallets */}
        {zignerWallets.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-sm font-bold mb-3'>penumbra wallets</p>
            <div className='flex flex-col gap-2'>
              {zignerWallets.map(({ wallet, index }) => (
                <div
                  key={wallet.id}
                  className='flex items-center justify-between border border-border bg-card-radial p-3'
                >
                  <div className='flex items-center gap-2 min-w-0'>
                    <EyeOpenIcon className='size-4 text-purple-500 flex-shrink-0' />
                    <span className='text-sm truncate'>{wallet.label}</span>
                  </div>

                  {confirmDelete === index ? (
                    <div className='flex items-center gap-2'>
                      <Button
                        variant='destructive'
                        size='sm'
                        onClick={() => handleDeleteWallet(index)}
                        disabled={deletingIndex === index || all.length <= 1}
                      >
                        {deletingIndex === index ? 'removing...' : 'confirm'}
                      </Button>
                      <Button
                        variant='secondary'
                        size='sm'
                        onClick={() => setConfirmDelete(null)}
                        disabled={deletingIndex === index}
                      >
                        cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => setConfirmDelete(index)}
                      disabled={all.length <= 1}
                      title={all.length <= 1 ? 'cannot remove the last wallet' : 'remove wallet'}
                    >
                      <TrashIcon className='size-4 text-muted-foreground hover:text-red-400' />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Existing Zcash Wallets */}
        {zcashWallets.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-sm font-bold mb-3'>zcash wallets</p>
            <div className='flex flex-col gap-2'>
              {zcashWallets.map((wallet, index) => (
                <div
                  key={wallet.id}
                  className='flex items-center justify-between border border-border bg-card-radial p-3'
                >
                  <div className='flex items-center gap-2 min-w-0'>
                    <EyeOpenIcon className='size-4 text-yellow-500 flex-shrink-0' />
                    <span className='text-sm truncate'>{wallet.label}</span>
                    <span className='text-[10px] px-1 bg-muted text-muted-foreground'>
                      {wallet.mainnet ? 'mainnet' : 'testnet'}
                    </span>
                  </div>

                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => removeZcashWallet(index)}
                    title='remove wallet'
                  >
                    <TrashIcon className='size-4 text-muted-foreground hover:text-red-400' />
                  </Button>
                </div>
              ))}
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
                  disabled={(!walletImport && !zcashWalletImport && !parsedPolkadotExport) || isAdding}
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
                  {parsedPolkadotExport ? (
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
                onClick={() => openPageInTab(PagePath.IMPORT_ZIGNER)}
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
