import { BackIcon } from '@repo/ui/components/ui/icons/back-icon';
import { Button } from '@repo/ui/components/ui/button';
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
import { PagePath } from '../paths';
import { setOnboardingValuesInStorage } from './persist-parameters';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToPasswordPage } from './password/utils';

/**
 * access-level note on a scanned import. one tight line, no prose - the
 * import is always watch-only; the key never leaves the cold device.
 */
const AccessNote = ({ kind }: { kind: 'airgap' | 'watch-only' }) => (
  <div
    className={cn(
      'flex flex-col gap-1 rounded-lg border p-3 text-left',
      kind === 'airgap'
        ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400'
        : 'border-pink-500/40 bg-pink-500/10 text-pink-200',
    )}
  >
    <p className='flex items-center gap-1.5 text-sm font-medium lowercase'>
      <span className={cn(kind === 'airgap' ? 'i-ph-shield' : 'i-ph-eye', 'h-3.5 w-3.5')} />
      {kind === 'airgap' ? 'airgap signer' : 'watch-only account'}
    </p>
    <p className='text-xs text-fg-muted lowercase'>
      view balances and build transactions. signing needs your zigner.
    </p>
  </div>
);

/**
 * password-or-skip footer shown after any successful scan. identical across
 * every detected network, so it lives here once.
 */
const PasswordChoice = ({
  importing,
  onSetPassword,
  onSkip,
  onScanAgain,
}: {
  importing: boolean;
  onSetPassword: () => void;
  onSkip: () => void;
  onScanAgain: () => void;
}) => (
  <div className='flex flex-col gap-2'>
    <Button variant='gradient' className='w-full' onClick={onSetPassword} disabled={importing}>
      set password
    </Button>
    <p className='text-center text-xs text-fg-muted lowercase'>
      required to use apps. more secure.
    </p>

    <Button variant='secondary' className='mt-2 w-full' onClick={onSkip} disabled={importing}>
      {importing ? 'importing...' : 'skip password'}
    </Button>
    <p className='text-center text-xs text-fg-muted lowercase'>no login needed. less secure.</p>

    <Button variant='ghost' className='mt-2 w-full' onClick={onScanAgain} disabled={importing}>
      scan again
    </Button>
  </div>
);

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
          : (zcashWalletImport.ufvk ?? undefined);
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
          onClose={() => {
            setKeystoneMode(false);
            setScanState('idle');
          }}
          title='scan keystone QR'
          description='hold the camera steady on the animated zcash-accounts QR'
          urTypeFilter='zcash-accounts'
        />
      );
    }
    return (
      <QrScanner
        onScan={handleScan}
        onError={setError}
        onClose={() => setScanState('idle')}
        title='scan zigner QR'
        description="point the camera at your zigner's viewing-key QR"
      />
    );
  }

  const showManualInput = manualInputRef.current && scanState !== 'scanned';

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <BackIcon onClick={handleBack} />
            {/* title doubles as the hidden manual-input trigger (10 clicks) */}
            <h2
              onClick={handleIconClick}
              className='cursor-default text-2xl lowercase tracking-[-0.01em] text-fg-high'
            >
              connect zigner
            </h2>
          </div>
          <p className='text-xs text-fg-muted lowercase'>
            scan the viewing-key QR from your zigner to add a watch-only wallet.
          </p>
        </header>

        <div className='flex flex-col gap-4'>
          {/* idle - scan buttons */}
          {scanState === 'idle' && !showManualInput && (
            <div className='flex flex-col gap-2.5'>
              {/* how to get the QR off the zigner */}
              <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-3'>
                <span className='flex items-center gap-1.5 text-xs font-medium text-fg-high lowercase'>
                  <span className='i-ph-device-mobile h-3.5 w-3.5 text-zigner-gold' />
                  on your zigner
                </span>
                <ol className='flex flex-col gap-1.5'>
                  {(
                    [
                      'open the zcash key path',
                      'select FVK (viewing key)',
                      'scan the QR it shows below',
                    ] as const
                  ).map((label, i) => (
                    <li key={i} className='flex items-center gap-2 text-xs text-fg-muted lowercase'>
                      <span className='flex size-4 shrink-0 items-center justify-center rounded-full bg-zigner-gold/15 text-[9px] text-zigner-gold'>
                        {i + 1}
                      </span>
                      {label}
                    </li>
                  ))}
                </ol>
              </div>

              <Button
                variant='gradient'
                className='w-full'
                onClick={() => {
                  setKeystoneMode(false);
                  setScanState('scanning');
                }}
              >
                <span className='i-ph-scan mr-2 h-4 w-4' />
                scan zigner QR
              </Button>

              <Button
                variant='secondary'
                className='w-full'
                onClick={() => {
                  setKeystoneMode(true);
                  setScanState('scanning');
                }}
              >
                <span className='i-ph-scan mr-2 h-4 w-4' />
                scan keystone QR (zcash)
              </Button>

              {errorMessage && <div className='mt-1 text-sm text-red-400'>{errorMessage}</div>}
            </div>
          )}

          {/* hidden developer mode - paste raw QR hex */}
          {showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-xs text-fg-muted lowercase'>developer mode. paste QR hex.</p>
              <Input
                placeholder='QR hex (starts with 530301...)'
                onChange={e => handleManualInput(e.target.value)}
                className='font-mono text-xs'
              />
              <Input
                placeholder='wallet label (optional)'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />
              {errorMessage && <div className='text-sm text-red-400'>{errorMessage}</div>}
              <div className='flex gap-2'>
                <Button variant='secondary' className='flex-1' onClick={resetState}>
                  cancel
                </Button>
                <Button
                  variant='gradient'
                  className='flex-1'
                  disabled={!walletImport && !zcashWalletImport && !parsedPolkadotExport}
                  onClick={handleSkip}
                >
                  import
                </Button>
              </div>
            </div>
          )}

          {/* Scanned state - show wallet info and confirm (Penumbra) */}
          {scanState === 'scanned' && detectedNetwork === 'penumbra' && walletImport && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <div className='text-title text-fg-high lowercase tracking-[-0.005em]'>
                  penumbra account detected
                </div>
                <div className={cn('font-mono text-fg-muted', 'text-xs', 'break-all')}>
                  account #{walletImport.accountIndex}
                </div>
              </div>

              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              <AccessNote kind='airgap' />

              {errorMessage && <div className='text-red-400 text-sm'>{errorMessage}</div>}

              <PasswordChoice
                importing={importing}
                onSetPassword={handleSetPassword}
                onSkip={handleSkip}
                onScanAgain={resetState}
              />
            </div>
          )}

          {/* Scanned state - Zcash */}
          {scanState === 'scanned' && detectedNetwork === 'zcash' && zcashWalletImport && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <div className='text-title text-fg-high lowercase tracking-[-0.005em]'>
                  zcash wallet detected
                </div>
                <div className={cn('font-mono text-fg-muted', 'text-xs', 'break-all')}>
                  account #{zcashWalletImport.accountIndex}
                  <span className='ml-2'>
                    {zcashWalletImport.mainnet ? '(mainnet)' : '(testnet)'}
                  </span>
                </div>
              </div>

              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              <AccessNote kind='airgap' />

              {errorMessage && <div className='text-red-400 text-sm'>{errorMessage}</div>}

              <PasswordChoice
                importing={importing}
                onSetPassword={handleSetPassword}
                onSkip={handleSkip}
                onScanAgain={resetState}
              />
            </div>
          )}

          {/* Scanned state - Cosmos */}
          {scanState === 'scanned' && detectedNetwork === 'cosmos' && parsedCosmosExport && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <div className='text-title text-fg-high lowercase tracking-[-0.005em]'>
                  cosmos account detected
                </div>
                {parsedCosmosExport.addresses.map(a => (
                  <div
                    key={a.chainId}
                    className={cn('font-mono text-fg-muted', 'text-xs', 'break-all')}
                  >
                    <span className='text-fg capitalize'>{a.chainId}:</span>{' '}
                    {a.address.slice(0, 12)}...{a.address.slice(-8)}
                  </div>
                ))}
              </div>

              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              <AccessNote kind='watch-only' />

              {errorMessage && <div className='text-red-400 text-sm'>{errorMessage}</div>}

              <PasswordChoice
                importing={importing}
                onSetPassword={handleSetPassword}
                onSkip={handleSkip}
                onScanAgain={resetState}
              />
            </div>
          )}

          {/* Scanned state - Polkadot */}
          {scanState === 'scanned' && detectedNetwork === 'polkadot' && parsedPolkadotExport && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <div className='text-title text-fg-high lowercase tracking-[-0.005em]'>
                  polkadot account detected
                </div>
                <div className={cn('font-mono text-fg-muted', 'text-xs', 'break-all')}>
                  {parsedPolkadotExport.address.slice(0, 12)}...
                  {parsedPolkadotExport.address.slice(-8)}
                </div>
              </div>

              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              <AccessNote kind='watch-only' />

              {errorMessage && <div className='text-red-400 text-sm'>{errorMessage}</div>}

              <PasswordChoice
                importing={importing}
                onSetPassword={handleSetPassword}
                onSkip={handleSkip}
                onScanAgain={resetState}
              />
            </div>
          )}

          {/* error */}
          {scanState === 'error' && !showManualInput && (
            <div className='flex flex-col gap-4'>
              <div className='text-sm text-red-400'>{errorMessage}</div>
              <Button variant='secondary' className='w-full' onClick={resetState}>
                try again
              </Button>
            </div>
          )}

          {/* importing */}
          {scanState === 'importing' && (
            <div className='flex flex-col items-center gap-3 py-8 text-fg-muted'>
              <span className='i-ph-circle-notch h-5 w-5 animate-spin' />
              <span className='text-sm lowercase'>importing wallet...</span>
            </div>
          )}
        </div>
      </div>
    </FadeTransition>
  );
};
