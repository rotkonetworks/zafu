import { BackIcon } from '@repo/ui/components/ui/icons/back-icon';
import { Button } from '@repo/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/ui/card';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { zignerConnectSelector } from '../../../state/zigner';
import { keyRingSelector, type ZignerZafuImport } from '../../../state/keyring';
import { usePageNav } from '../../../utils/navigate';
import { useCallback, useRef, useState } from 'react';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { CameraIcon, EyeOpenIcon } from '@radix-ui/react-icons';
import { LineWave } from 'react-loader-spinner';
import { PagePath } from '../paths';
import { setOnboardingValuesInStorage } from './persist-parameters';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToPasswordPage } from './password/utils';

/**
 * Zigner wallet import page for onboarding.
 * Allows users to scan a QR code from their Zigner device to import a watch-only wallet.
 */
export const ImportZigner = () => {
  const navigate = usePageNav();
  const {
    scanState,
    walletLabel,
    walletImport,
    zcashWalletImport,
    errorMessage,
    processQrData,
    setWalletLabel,
    setScanState,
    setError,
    clearZignerState,
  } = useStore(zignerConnectSelector);
  const { addZignerUnencrypted } = useStore(keyRingSelector);
  const [importing, setImporting] = useState(false);

  // Hidden manual input mode - activated by clicking eye icon 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualInputRef = useRef(false);

  const handleBack = () => {
    clearZignerState();
    navigate(-1);
  };

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

  // skip password - use default encryption
  const handleSkip = async () => {
    if (!walletImport && !zcashWalletImport) {
      setError('please scan a valid QR code first');
      return;
    }

    try {
      setImporting(true);

      if (walletImport) {
        // penumbra zigner import - convert protobuf to base64 strings
        const fvkInner = walletImport.fullViewingKey.inner;
        const walletIdInner = walletImport.walletId.inner;
        const zignerData: ZignerZafuImport = {
          fullViewingKey: fvkInner ? btoa(String.fromCharCode(...fvkInner)) : undefined,
          accountIndex: walletImport.accountIndex,
          deviceId: walletIdInner ? btoa(String.fromCharCode(...walletIdInner)) : `penumbra-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner penumbra');
      } else if (zcashWalletImport) {
        // zcash zigner import
        const zignerData: ZignerZafuImport = {
          viewingKey: zcashWalletImport.orchardFvk
            ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
            : undefined,
          accountIndex: zcashWalletImport.accountIndex,
          deviceId: `zcash-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner zcash');
      }

      await setOnboardingValuesInStorage(SEED_PHRASE_ORIGIN.ZIGNER);
      clearZignerState();
      navigate(PagePath.ONBOARDING_SUCCESS);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`failed to import: ${message}`);
    } finally {
      setImporting(false);
    }
  };

  // set custom password - navigate to password page
  const handleSetPassword = () => {
    if (!walletImport && !zcashWalletImport) {
      setError('please scan a valid QR code first');
      return;
    }
    // zigner state preserved in store, password hooks will handle import
    navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.ZIGNER);
  };

  const resetState = () => {
    clearZignerState();
    manualInputRef.current = false;
  };

  // Full-screen scanner mode
  if (scanState === 'scanning') {
    return (
      <QrScanner
        onScan={handleScan}
        onError={setError}
        onClose={() => setScanState('idle')}
title="Scan Zafu Zigner QR"
        description="Point camera at your Zafu Zigner's FVK QR code"
      />
    );
  }

  const showManualInput = manualInputRef.current && scanState !== 'scanned';

  return (
    <FadeTransition>
      <BackIcon className='float-left mb-4' onClick={handleBack} />
      <Card className={cn('p-6', 'w-[600px]')} gradient>
        <CardHeader className='items-center'>
          <div onClick={handleIconClick} className='cursor-default'>
            <EyeOpenIcon className='size-8 mb-2 text-muted-foreground' />
          </div>
          <CardTitle className='font-semibold'>Connect Zafu Zigner</CardTitle>
          <CardDescription className='text-center'>
            {scanState === 'idle' && !showManualInput && !importing && (
              <>
                <div>Export the viewing key from your Zafu Zigner device.</div>
                <div>Scan the QR code to import as watch-only wallet.</div>
              </>
            )}
            {importing && (
              <LineWave
                visible={true}
                height='60'
                width='60'
                color='#FFFFFF'
                wrapperClass='mt-[-17.5px] mr-[-21px]'
              />
            )}
            {scanState === 'scanned' && !importing && <div>QR code scanned successfully.</div>}
            {scanState === 'error' && <div className='text-red-400'>Scan failed</div>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className='text-center'>
            {/* Idle state - show scan button */}
            {scanState === 'idle' && !showManualInput && (
              <div className='flex flex-col gap-4'>
                <Button
                  variant='gradient'
                  className='mt-4'
                  onClick={() => setScanState('scanning')}
                >
                  <CameraIcon className='size-5 mr-2' />
                  Scan QR Code
                </Button>

                {errorMessage && (
                  <div className='text-red-400 text-sm mt-2'>{errorMessage}</div>
                )}
              </div>
            )}

            {/* Hidden manual input mode (developer mode) */}
            {showManualInput && (
              <div className='flex flex-col gap-4 text-left'>
                <p className='text-sm text-muted-foreground text-center'>
                  Developer mode: Paste QR hex data
                </p>
                <Input
                  placeholder='Paste QR code hex (starts with 530301...)'
                  onChange={e => handleManualInput(e.target.value)}
                  className='font-mono text-xs'
                />
                <Input
                  placeholder='Wallet label (optional)'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                />
                {errorMessage && (
                  <div className='text-red-400 text-sm'>{errorMessage}</div>
                )}
                <div className='flex gap-2'>
                  <Button
                    variant='secondary'
                    className='flex-1'
                    onClick={resetState}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant='gradient'
                    className='flex-1'
                    disabled={!walletImport && !zcashWalletImport}
                    onClick={handleSkip}
                  >
                    Import
                  </Button>
                </div>
              </div>
            )}

            {/* Scanned state - show wallet info and confirm */}
            {scanState === 'scanned' && walletImport && (
              <div className='flex flex-col gap-4'>
                <div className='p-6'>
                  <div className='font-headline text-lg'>Success!</div>
                  <div className={cn('font-mono text-muted-foreground', 'text-xs', 'break-all', 'mt-2')}>
                    Account #{walletImport.accountIndex}
                  </div>
                </div>

                <Input
                  placeholder='Wallet label'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                  className='text-center'
                />

                <div className='rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200 text-left'>
                  <p className='font-medium'>Airgap Signer</p>
                  <p className='mt-1 text-muted-foreground text-xs'>
                    View balances and create transactions. Signing requires your Zafu Zigner device.
                  </p>
                </div>

                {errorMessage && (
                  <div className='text-red-400 text-sm'>{errorMessage}</div>
                )}

                <div className='flex flex-col gap-2 mt-2'>
                  <Button
                    variant='gradient'
                    className='w-full'
                    onClick={handleSetPassword}
                    disabled={importing}
                  >
                    Set Password
                  </Button>
                  <p className='text-xs text-muted-foreground text-center'>
                    Requires login to use apps. More secure.
                  </p>

                  <Button
                    variant='secondary'
                    className='w-full mt-2'
                    onClick={handleSkip}
                    disabled={importing}
                  >
                    {importing ? 'Importing...' : 'Skip Password'}
                  </Button>
                  <p className='text-xs text-muted-foreground text-center'>
                    No login required. Less secure.
                  </p>

                  <Button variant='ghost' className='w-full mt-2' onClick={resetState} disabled={importing}>
                    Scan Again
                  </Button>
                </div>
              </div>
            )}

            {/* Error state */}
            {scanState === 'error' && !showManualInput && (
              <div className='flex flex-col gap-4'>
                <div className='text-red-400'>{errorMessage}</div>
                <Button variant='secondary' onClick={resetState}>
                  Try Again
                </Button>
              </div>
            )}

            {/* Importing state */}
            {scanState === 'importing' && (
              <div className='flex flex-col items-center gap-4 p-8'>
                <div className='text-muted-foreground'>Importing wallet...</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </FadeTransition>
  );
};
