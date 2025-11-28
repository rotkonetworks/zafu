import { CameraIcon, EyeOpenIcon, TrashIcon, ExternalLinkIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { walletsSelector } from '../../../state/wallets';
import { zignerConnectSelector } from '../../../state/zigner';
import { SettingsScreen } from './settings-screen';
import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { useState, useRef, useEffect, useCallback } from 'react';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { PagePath } from '../../page/paths';
import {
  isPopup,
  openPageInTab,
  checkCameraPermission,
  requestCameraPermission,
} from '../../../utils/popup-detection';

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
  const { all, addAirgapSignerWallet, removeWallet } = useStore(walletsSelector);
  const {
    scanState,
    walletLabel,
    walletImport,
    errorMessage,
    processQrData,
    setWalletLabel,
    setScanState,
    setError,
    clearZignerState,
  } = useStore(zignerConnectSelector);

  const [success, setSuccess] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [cameraGranted, setCameraGranted] = useState<boolean | null>(null);
  const [requestingCamera, setRequestingCamera] = useState(false);

  // Get list of Zigner wallets with their indices
  const zignerWallets = all
    .map((wallet, index) => ({ wallet, index }))
    .filter(({ wallet }) => isZignerWallet(wallet.custody));

  // Hidden paste mode - activated by clicking icon 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualInputRef = useRef(false);

  // Check camera permission on mount
  useEffect(() => {
    void checkCameraPermission().then(setCameraGranted);
  }, []);

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

  const handleScan = useCallback(
    (data: string) => {
      processQrData(data);
    },
    [processQrData],
  );

  const handleManualInput = (value: string) => {
    if (value.trim()) {
      processQrData(value);
    }
  };

  const handleAddWallet = async () => {
    if (!walletImport) {
      setError('Please scan a QR code first');
      return;
    }

    try {
      setIsAdding(true);
      await addAirgapSignerWallet(walletImport);

      setSuccess(true);
      clearZignerState();
      manualInputRef.current = false;

      setTimeout(() => setSuccess(false), 3000);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Failed to add wallet: ${message}`);
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

  // Full-screen scanner mode - camera permission is requested automatically by QrScanner
  if (scanState === 'scanning') {
    return (
      <QrScanner
        onScan={handleScan}
        onError={setError}
        onClose={() => setScanState('idle')}
        title="Scan Zigner QR"
        description="Point camera at your Zigner's FVK QR code"
      />
    );
  }

  const showManualInput = manualInputRef.current && scanState !== 'scanned';
  const showScannedState = scanState === 'scanned' && walletImport;
  const showInitialState = scanState === 'idle' && !showManualInput;

  return (
    <SettingsScreen
      title='Zigner'
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
            Zigner is a cold wallet that keeps your spending keys offline. Prax stores only the
            viewing key to show balances. Transactions require QR code signing with your Zigner
            device.
          </p>
        </div>

        {/* Existing Zigner Wallets */}
        {zignerWallets.length > 0 && (
          <div className='border-t border-border pt-4'>
            <p className='text-sm font-bold mb-3'>Your Zigner Wallets</p>
            <div className='flex flex-col gap-2'>
              {zignerWallets.map(({ wallet, index }) => (
                <div
                  key={wallet.id}
                  className='flex items-center justify-between rounded-lg border border-border bg-card-radial p-3'
                >
                  <div className='flex items-center gap-2 min-w-0'>
                    <EyeOpenIcon className='size-4 text-yellow-500 flex-shrink-0' />
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
                        {deletingIndex === index ? 'Removing...' : 'Confirm'}
                      </Button>
                      <Button
                        variant='secondary'
                        size='sm'
                        onClick={() => setConfirmDelete(null)}
                        disabled={deletingIndex === index}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => setConfirmDelete(index)}
                      disabled={all.length <= 1}
                      title={all.length <= 1 ? 'Cannot remove the last wallet' : 'Remove wallet'}
                    >
                      <TrashIcon className='size-4 text-muted-foreground hover:text-red-400' />
                    </Button>
                  )}
                </div>
              ))}
              {all.length <= 1 && zignerWallets.length > 0 && (
                <p className='text-xs text-muted-foreground text-center'>
                  Cannot remove the last wallet. Add another wallet first.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Success message */}
        {success && (
          <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400'>
            Zigner wallet added successfully!
          </div>
        )}

        {/* Add Zigner Wallet section */}
        <div className='border-t border-border pt-4'>
          <p className='text-sm font-bold mb-3'>Add Zigner Wallet</p>

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
                  disabled={!walletImport || isAdding}
                >
                  {isAdding ? 'Adding...' : 'Add Wallet'}
                </Button>
              </div>
            </div>
          )}

          {/* Scanned QR - ready to add */}
          {showScannedState && (
            <div className='flex flex-col gap-3'>
              <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
                <p className='text-sm font-medium text-green-400'>QR Code Scanned</p>
                <p className='text-xs text-muted-foreground mt-1'>
                  Account #{walletImport.accountIndex}
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
              {/* Camera permission not granted and we're in popup - need to open full page */}
              {!cameraGranted && isPopup() ? (
                <>
                  <p className='text-xs text-muted-foreground text-center mb-2'>
                    Camera access requires opening in a new tab
                  </p>
                  <Button
                    variant='secondary'
                    className='w-full'
                    onClick={() => openPageInTab(PagePath.GRANT_CAMERA)}
                  >
                    <ExternalLinkIcon className='size-4 mr-2' />
                    Grant Camera Access
                  </Button>
                </>
              ) : !cameraGranted ? (
                // We're in a full page - can request camera permission
                <>
                  <Button
                    variant='secondary'
                    className='w-full'
                    onClick={async () => {
                      setRequestingCamera(true);
                      const granted = await requestCameraPermission();
                      setCameraGranted(granted);
                      setRequestingCamera(false);
                      if (granted) {
                        setScanState('scanning');
                      } else {
                        setError('Camera permission denied. Please allow camera access and try again.');
                      }
                    }}
                    disabled={requestingCamera}
                  >
                    <CameraIcon className='size-4 mr-2' />
                    {requestingCamera ? 'Requesting...' : 'Grant Camera Access'}
                  </Button>
                </>
              ) : (
                // Camera already granted - can scan directly
                <Button
                  variant='secondary'
                  className='w-full'
                  onClick={() => setScanState('scanning')}
                >
                  <CameraIcon className='size-4 mr-2' />
                  Scan Zigner QR Code
                </Button>
              )}
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
