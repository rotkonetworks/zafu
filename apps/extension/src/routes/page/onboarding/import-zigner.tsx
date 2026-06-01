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
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
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
    parsedPolkadotExport,
    parsedCosmosExport,
    detectedNetwork,
    errorMessage,
    processQrData,
    processZcashAccountsBytes,
    setWalletLabel,
    setScanState,
    setError,
    clearZignerState,
  } = useStore(zignerConnectSelector);
  // Tracks whether the user picked the Keystone-class flow (animated multipart
  // UR over `ur:zcash-accounts`). Distinct from the legacy zigner scan to keep
  // UI semantics clear and avoid regressing the static-QR happy path.
  const [keystoneMode, setKeystoneMode] = useState(false);
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
    if (!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) {
      setError('please scan a valid QR code first');
      return;
    }

    try {
      setImporting(true);

      if (walletImport) {
        // penumbra zigner import - convert protobuf to base64 strings
        const fvkInner = walletImport.fullViewingKey.inner;
        const walletIdInner = walletImport.walletId.inner;
        // use ZID as canonical deviceId when available — same zigner seed
        // produces same ZID regardless of network, enabling proper dedup.
        const legacyDeviceId = walletIdInner
          ? btoa(String.fromCharCode(...walletIdInner))
          : `penumbra-${Date.now()}`;
        const zignerData: ZignerZafuImport = {
          fullViewingKey: fvkInner ? btoa(String.fromCharCode(...fvkInner)) : undefined,
          accountIndex: walletImport.accountIndex,
          deviceId: walletImport.zidPublicKey ?? legacyDeviceId,
          zidPublicKey: walletImport.zidPublicKey,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner penumbra');
      } else if (zcashWalletImport) {
        // zcash import — for zigner, use ZID as canonical deviceId so
        // same-device imports across networks dedup. Keystone has no ZID;
        // fall back to a hash-based deviceId so reimporting the same FVK
        // still dedups against itself.
        const kind = zcashWalletImport.coldSignerType ?? 'zigner';
        const ufvkOrFvkB64 = zcashWalletImport.orchardFvk
          ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
          : zcashWalletImport.ufvk ?? undefined;
        // Stable deviceId for keystone: hash of the ufvk (16-char prefix). The
        // ufvk is the only canonical, immutable identifier we have for a
        // Keystone wallet. A timestamp would mean "reimporting the same
        // wallet" creates a new deviceId every time — bad for dedup.
        let deviceId = zcashWalletImport.zidPublicKey;
        if (!deviceId) {
          if (kind === 'keystone' && ufvkOrFvkB64) {
            // Quick non-crypto digest sufficient for dedup. Switch to a real
            // hash if collision becomes a concern.
            let h = 5381;
            for (let i = 0; i < ufvkOrFvkB64.length; i++) {
              h = ((h << 5) + h + ufvkOrFvkB64.charCodeAt(i)) | 0;
            }
            deviceId = `keystone-${(h >>> 0).toString(16)}`;
          } else {
            deviceId = `zcash-${Date.now()}`;
          }
        }
        const defaultLabel = kind === 'keystone' ? 'keystone zcash' : 'zigner zcash';
        const zignerData: ZignerZafuImport = {
          viewingKey: ufvkOrFvkB64,
          accountIndex: zcashWalletImport.accountIndex,
          deviceId,
          zidPublicKey: zcashWalletImport.zidPublicKey,
          coldSignerType: kind,
        };
        await addZignerUnencrypted(zignerData, walletLabel || defaultLabel);
      } else if (parsedCosmosExport) {
        // cosmos zigner import - watch-only addresses
        const zignerData: ZignerZafuImport = {
          cosmosAddresses: parsedCosmosExport.addresses,
          publicKey: parsedCosmosExport.publicKey || undefined,
          accountIndex: parsedCosmosExport.accountIndex,
          deviceId: `cosmos-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner cosmos');
      } else if (parsedPolkadotExport) {
        // polkadot zigner import - watch-only address
        const zignerData: ZignerZafuImport = {
          polkadotSs58: parsedPolkadotExport.address,
          polkadotGenesisHash: parsedPolkadotExport.genesisHash,
          accountIndex: 0,
          deviceId: `polkadot-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner polkadot');
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
    if (!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) {
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
    if (keystoneMode) {
      // Keystone (and any UR-multipart-emitting cold signer) sends the FVK
      // as `ur:zcash-accounts` — possibly across multiple frames. The
      // AnimatedQrScanner accumulates frames, decodes via the wasm fountain
      // decoder, and hands us the inner CBOR which we parse directly.
      return (
        <AnimatedQrScanner
          onComplete={(bytes, urType) => {
            if (urType !== 'zcash-accounts') {
              setError(`expected ur:zcash-accounts, got ur:${urType}`);
              return;
            }
            // Trust the button: this scanner only opens when the user clicked
            // "Scan Keystone". Pass that explicitly so the state action
            // doesn't have to infer from byte presence.
            processZcashAccountsBytes(bytes, 'keystone');
          }}
          onError={setError}
          onClose={() => { setKeystoneMode(false); setScanState('idle'); }}
          title="Scan Keystone QR"
          description="Hold the camera steady on the animated zcash-accounts QR"
          urTypeFilter="zcash-accounts"
        />
      );
    }
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
          <div onClick={handleIconClick} className='cursor-pointer'>
            <span className='i-lucide-eye size-8 mb-2 text-fg-muted' />
          </div>
          <CardTitle className='font-medium'>Connect Zafu Zigner</CardTitle>
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
            {/* Idle state - show scan buttons */}
            {scanState === 'idle' && !showManualInput && (
              <div className='flex flex-col gap-3'>
                <Button
                  variant='gradient'
                  className='mt-4'
                  onClick={() => { setKeystoneMode(false); setScanState('scanning'); }}
                >
                  <span className='i-lucide-camera size-5 mr-2' />
                  Scan QR Code (Zigner)
                </Button>

                <Button
                  variant='secondary'
                  onClick={() => { setKeystoneMode(true); setScanState('scanning'); }}
                >
                  <span className='i-lucide-camera size-5 mr-2' />
                  Scan Keystone (animated UR, zcash only)
                </Button>

                {errorMessage && (
                  <div className='text-red-400 text-sm mt-2'>{errorMessage}</div>
                )}
              </div>
            )}

            {/* Hidden manual input mode (developer mode) */}
            {showManualInput && (
              <div className='flex flex-col gap-4 text-left'>
                <p className='text-sm text-fg-muted text-center'>
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
                    disabled={!walletImport && !zcashWalletImport && !parsedPolkadotExport}
                    onClick={handleSkip}
                  >
                    Import
                  </Button>
                </div>
              </div>
            )}

            {/* Scanned state - show wallet info and confirm (Penumbra) */}
            {scanState === 'scanned' && detectedNetwork === 'penumbra' && walletImport && (
              <div className='flex flex-col gap-4'>
                <div className='p-6'>
                  <div className='text-[15px] text-fg-high lowercase tracking-[-0.005em]'>Success!</div>
                  <div className={cn('font-mono text-fg-muted', 'text-xs', 'break-all', 'mt-2')}>
                    Account #{walletImport.accountIndex}
                  </div>
                </div>

                <Input
                  placeholder='Wallet label'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                  className='text-center'
                />

                <div className='rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-400 text-left'>
                  <p className='font-medium'>Airgap Signer</p>
                  <p className='mt-1 text-fg-muted text-xs'>
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
                  <p className='text-xs text-fg-muted text-center'>
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
                  <p className='text-xs text-fg-muted text-center'>
                    No login required. Less secure.
                  </p>

                  <Button variant='ghost' className='w-full mt-2' onClick={resetState} disabled={importing}>
                    Scan Again
                  </Button>
                </div>
              </div>
            )}

            {/* Scanned state - Zcash */}
            {scanState === 'scanned' && detectedNetwork === 'zcash' && zcashWalletImport && (
              <div className='flex flex-col gap-4'>
                <div className='p-6'>
                  <div className='text-[15px] text-fg-high lowercase tracking-[-0.005em]'>Zcash Wallet Detected!</div>
                  <div className={cn('font-mono text-fg-muted', 'text-xs', 'break-all', 'mt-2')}>
                    Account #{zcashWalletImport.accountIndex}
                    <span className='ml-2'>{zcashWalletImport.mainnet ? '(mainnet)' : '(testnet)'}</span>
                  </div>
                </div>

                <Input
                  placeholder='Wallet label'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                  className='text-center'
                />

                <div className='rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-400 text-left'>
                  <p className='font-medium'>Airgap Signer</p>
                  <p className='mt-1 text-fg-muted text-xs'>
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
                  <p className='text-xs text-fg-muted text-center'>
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
                  <p className='text-xs text-fg-muted text-center'>
                    No login required. Less secure.
                  </p>

                  <Button variant='ghost' className='w-full mt-2' onClick={resetState} disabled={importing}>
                    Scan Again
                  </Button>
                </div>
              </div>
            )}

            {/* Scanned state - Cosmos */}
            {scanState === 'scanned' && detectedNetwork === 'cosmos' && parsedCosmosExport && (
              <div className='flex flex-col gap-4'>
                <div className='p-6'>
                  <div className='text-[15px] text-fg-high lowercase tracking-[-0.005em]'>Cosmos Account Detected!</div>
                  {parsedCosmosExport.addresses.map(a => (
                    <div key={a.chainId} className={cn('font-mono text-fg-muted', 'text-xs', 'break-all', 'mt-2')}>
                      <span className='text-fg capitalize'>{a.chainId}:</span>{' '}
                      {a.address.slice(0, 12)}...{a.address.slice(-8)}
                    </div>
                  ))}
                </div>

                <Input
                  placeholder='Wallet label'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                  className='text-center'
                />

                <div className='rounded-lg border border-pink-500/40 bg-pink-500/10 p-3 text-sm text-pink-200 text-left'>
                  <p className='font-medium'>Watch-Only Account</p>
                  <p className='mt-1 text-fg-muted text-xs'>
                    View balances and create unsigned transactions. Signing requires your Zafu Zigner device via QR codes.
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
                  <p className='text-xs text-fg-muted text-center'>
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
                  <p className='text-xs text-fg-muted text-center'>
                    No login required. Less secure.
                  </p>

                  <Button variant='ghost' className='w-full mt-2' onClick={resetState} disabled={importing}>
                    Scan Again
                  </Button>
                </div>
              </div>
            )}

            {/* Scanned state - Polkadot */}
            {scanState === 'scanned' && detectedNetwork === 'polkadot' && parsedPolkadotExport && (
              <div className='flex flex-col gap-4'>
                <div className='p-6'>
                  <div className='text-[15px] text-fg-high lowercase tracking-[-0.005em]'>Polkadot Account Detected!</div>
                  <div className={cn('font-mono text-fg-muted', 'text-xs', 'break-all', 'mt-2')}>
                    {parsedPolkadotExport.address.slice(0, 12)}...{parsedPolkadotExport.address.slice(-8)}
                  </div>
                </div>

                <Input
                  placeholder='Wallet label'
                  value={walletLabel}
                  onChange={e => setWalletLabel(e.target.value)}
                  className='text-center'
                />

                <div className='rounded-lg border border-pink-500/40 bg-pink-500/10 p-3 text-sm text-pink-200 text-left'>
                  <p className='font-medium'>Watch-Only Account</p>
                  <p className='mt-1 text-fg-muted text-xs'>
                    View balances and create unsigned transactions. Signing requires your Zafu Zigner device via QR codes.
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
                  <p className='text-xs text-fg-muted text-center'>
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
                  <p className='text-xs text-fg-muted text-center'>
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
                <div className='text-fg-muted'>Importing wallet...</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </FadeTransition>
  );
};
