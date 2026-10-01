import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { zignerConnectSelector } from '../../../state/zigner';
import { keyRingSelector, type ZignerZafuImport } from '../../../state/keyring';
import { usePageNav } from '../../../utils/navigate';
import { useCallback, useRef, useState } from 'react';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { PagePath } from '../paths';
import { keystoneDeviceId } from '../../../utils/viewing-key';
import { setOnboardingValuesInStorage } from './persist-parameters';
import { SEED_PHRASE_ORIGIN } from './password/types';
import { navigateToPasswordPage } from './password/utils';
import { OnboardingBack, OnboardingShell } from './onboarding-shell';

/**
 * access-level note on a scanned import. one tight line, no prose - the
 * import is always watch-only; the key never leaves the cold device.
 */
const AccessNote = ({ kind }: { kind: 'airgap' | 'watch-only' }) => (
  <StatusSlot
    tone={kind === 'airgap' ? 'gold' : 'info'}
    icon={kind === 'airgap' ? 'i-ph-shield' : 'i-ph-eye'}
  >
    {kind === 'airgap' ? 'airgap signer' : 'watch-only account'} - view balances and build
    transactions. signing needs your zigner.
  </StatusSlot>
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
    <Button
      variant='primary'
      className='h-14 w-full text-body'
      onClick={onSetPassword}
      disabled={importing}
    >
      set password
    </Button>
    <p className='text-center text-label text-fg-muted lowercase'>
      required to use apps. more secure.
    </p>

    <Button
      variant='secondary'
      className='mt-2 h-14 w-full text-body'
      onClick={onSkip}
      disabled={importing}
    >
      {importing ? 'importing...' : 'skip password'}
    </Button>
    <p className='text-center text-label text-fg-muted lowercase'>no login needed. less secure.</p>

    <Button variant='quiet' className='mt-2 w-full' onClick={onScanAgain} disabled={importing}>
      scan again
    </Button>
  </div>
);

type DetectedNet = 'penumbra' | 'zcash' | 'cosmos' | 'polkadot';

/** one detail line per network for the scanned-account summary. */
function detailLine(
  net: DetectedNet,
  ctx: {
    walletImport: ReturnType<typeof zignerConnectSelector>['walletImport'];
    zcashWalletImport: ReturnType<typeof zignerConnectSelector>['zcashWalletImport'];
    parsedCosmosExport: ReturnType<typeof zignerConnectSelector>['parsedCosmosExport'];
    parsedPolkadotExport: ReturnType<typeof zignerConnectSelector>['parsedPolkadotExport'];
  },
): { title: string; detail: React.ReactNode; kind: 'airgap' | 'watch-only' } | null {
  if (net === 'penumbra' && ctx.walletImport) {
    return {
      title: 'penumbra account detected',
      detail: <>account #{ctx.walletImport.accountIndex}</>,
      kind: 'airgap',
    };
  }
  if (net === 'zcash' && ctx.zcashWalletImport) {
    return {
      title: 'zcash wallet detected',
      detail: (
        <>
          account #{ctx.zcashWalletImport.accountIndex}
          <span className='ml-2'>{ctx.zcashWalletImport.mainnet ? '(mainnet)' : '(testnet)'}</span>
        </>
      ),
      kind: 'airgap',
    };
  }
  if (net === 'cosmos' && ctx.parsedCosmosExport) {
    return {
      title: 'cosmos account detected',
      detail: (
        <>
          {ctx.parsedCosmosExport.addresses.map(a => (
            <div key={a.chainId} className='break-all font-mono text-label text-fg-muted'>
              <span className='capitalize text-fg'>{a.chainId}:</span> {a.address.slice(0, 12)}...
              {a.address.slice(-8)}
            </div>
          ))}
        </>
      ),
      kind: 'watch-only',
    };
  }
  if (net === 'polkadot' && ctx.parsedPolkadotExport) {
    return {
      title: 'polkadot account detected',
      detail: (
        <>
          {ctx.parsedPolkadotExport.address.slice(0, 12)}...
          {ctx.parsedPolkadotExport.address.slice(-8)}
        </>
      ),
      kind: 'watch-only',
    };
  }
  return null;
}

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

  // Hidden manual input mode - activated by clicking the title 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualInputRef = useRef(false);

  const handleBack = () => {
    clearZignerState();
    navigate(-1);
  };

  const handleTitleClick = () => {
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

  const handleScan = useCallback((data: string) => processQrData(data), [processQrData]);
  const handleManualInput = (value: string) => value.trim() && processQrData(value);

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
        // use ZID as canonical deviceId when available - same zigner seed
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
        // zcash import - for zigner, use ZID as canonical deviceId so
        // same-device imports across networks dedup. Keystone has no ZID;
        // fall back to a hash-based deviceId so reimporting the same FVK
        // still dedups against itself.
        const kind = zcashWalletImport.coldSignerType ?? 'zigner';
        const ufvkOrFvkB64 = zcashWalletImport.orchardFvk
          ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
          : (zcashWalletImport.ufvk ?? undefined);
        let deviceId = zcashWalletImport.zidPublicKey;
        if (!deviceId) {
          deviceId =
            kind === 'keystone' && ufvkOrFvkB64
              ? keystoneDeviceId(ufvkOrFvkB64)
              : `zcash-${Date.now()}`;
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
        const zignerData: ZignerZafuImport = {
          cosmosAddresses: parsedCosmosExport.addresses,
          publicKey: parsedCosmosExport.publicKey || undefined,
          accountIndex: parsedCosmosExport.accountIndex,
          deviceId: `cosmos-${Date.now()}`,
        };
        await addZignerUnencrypted(zignerData, walletLabel || 'zigner cosmos');
      } else if (parsedPolkadotExport) {
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

  const handleSetPassword = () => {
    if (!walletImport && !zcashWalletImport && !parsedPolkadotExport && !parsedCosmosExport) {
      setError('please scan a valid QR code first');
      return;
    }
    navigateToPasswordPage(navigate, SEED_PHRASE_ORIGIN.ZIGNER);
  };

  const resetState = () => {
    clearZignerState();
    manualInputRef.current = false;
  };

  // Full-screen scanner mode
  if (scanState === 'scanning') {
    if (keystoneMode) {
      return (
        <AnimatedQrScanner
          onComplete={(bytes, urType) => {
            if (urType !== 'zcash-accounts') {
              setError(`expected ur:zcash-accounts, got ur:${urType}`);
              return;
            }
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
  const scanned =
    scanState === 'scanned' && detectedNetwork
      ? detailLine(detectedNetwork as DetectedNet, {
          walletImport,
          zcashWalletImport,
          parsedCosmosExport,
          parsedPolkadotExport,
        })
      : null;

  return (
    <OnboardingShell art='enso'>
      <FadeTransition>
        <div className='flex flex-col gap-5'>
          <OnboardingBack onClick={handleBack} />
          {/* title doubles as the hidden manual-input trigger (10 clicks) */}
          <h1
            onClick={handleTitleClick}
            className='cursor-default font-display text-[38px] text-fg-high'
          >
            connect zigner
          </h1>
          <p className='text-body text-fg-muted lowercase'>
            scan the viewing-key QR from your zigner to add a watch-only wallet.
          </p>

          {scanState === 'idle' && !showManualInput && (
            <div className='flex flex-col gap-2.5'>
              <div className='flex flex-col gap-2 border border-border-soft bg-elev-1 p-3'>
                <span className='flex items-center gap-1.5 text-label text-fg-high lowercase'>
                  <span className='i-ph-device-mobile size-3.5 text-zigner-gold' />
                  on your zigner
                </span>
                <ol className='flex flex-col gap-1.5'>
                  {[
                    'open the zcash key path',
                    'select FVK (viewing key)',
                    'scan the QR it shows below',
                  ].map((label, i) => (
                    <li
                      key={i}
                      className='flex items-center gap-2 text-label text-fg-muted lowercase'
                    >
                      <span className='flex size-4 shrink-0 items-center justify-center bg-zigner-gold/15 text-[9px] text-zigner-gold'>
                        {i + 1}
                      </span>
                      {label}
                    </li>
                  ))}
                </ol>
              </div>

              <Button
                variant='primary'
                className='h-14 w-full text-body'
                onClick={() => {
                  setKeystoneMode(false);
                  setScanState('scanning');
                }}
              >
                <span className='i-ph-scan mr-2 size-4' />
                scan zigner QR
              </Button>
              <Button
                variant='secondary'
                className='h-14 w-full text-body'
                onClick={() => {
                  setKeystoneMode(true);
                  setScanState('scanning');
                }}
              >
                <span className='i-ph-scan mr-2 size-4' />
                scan keystone QR (zcash)
              </Button>

              {errorMessage && (
                <StatusSlot tone='danger' icon='i-ph-warning'>
                  {errorMessage}
                </StatusSlot>
              )}
            </div>
          )}

          {showManualInput && (
            <div className='flex flex-col gap-3'>
              <p className='text-label text-fg-muted lowercase'>developer mode. paste QR hex.</p>
              <Input
                placeholder='QR hex (starts with 530301...)'
                onChange={e => handleManualInput(e.target.value)}
                className='font-mono text-label'
              />
              <Input
                placeholder='wallet label (optional)'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />
              {errorMessage && (
                <StatusSlot tone='danger' icon='i-ph-warning'>
                  {errorMessage}
                </StatusSlot>
              )}
              <div className='flex gap-2'>
                <Button variant='secondary' className='flex-1' onClick={resetState}>
                  cancel
                </Button>
                <Button
                  variant='primary'
                  className='flex-1'
                  disabled={!walletImport && !zcashWalletImport && !parsedPolkadotExport}
                  onClick={() => void handleSkip()}
                >
                  import
                </Button>
              </div>
            </div>
          )}

          {scanned && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <div className='text-body text-fg-high lowercase'>{scanned.title}</div>
                <div className={cn('font-mono text-fg-muted', 'text-label', 'break-all')}>
                  {scanned.detail}
                </div>
              </div>
              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />
              <AccessNote kind={scanned.kind} />
              {errorMessage && (
                <StatusSlot tone='danger' icon='i-ph-warning'>
                  {errorMessage}
                </StatusSlot>
              )}
              <PasswordChoice
                importing={importing}
                onSetPassword={handleSetPassword}
                onSkip={() => void handleSkip()}
                onScanAgain={resetState}
              />
            </div>
          )}

          {scanState === 'error' && !showManualInput && (
            <div className='flex flex-col gap-4'>
              <StatusSlot tone='danger' icon='i-ph-warning'>
                {errorMessage}
              </StatusSlot>
              <Button variant='secondary' className='w-full' onClick={resetState}>
                try again
              </Button>
            </div>
          )}

          {scanState === 'importing' && (
            <div className='flex flex-col items-center gap-3 py-8 text-fg-muted'>
              <span className='i-ph-circle-notch size-5 animate-spin' />
              <span className='text-body lowercase'>importing wallet...</span>
            </div>
          )}
        </div>
      </FadeTransition>
    </OnboardingShell>
  );
};
