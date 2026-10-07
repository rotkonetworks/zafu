import { Button } from '@repo/ui/components/ui/button';
import { Input } from '@repo/ui/components/ui/input';
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
import { localExtStorage } from '@repo/storage-chrome/local';
import { Clipped } from '@repo/ui/components/ui/clipped';

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
      set a password
    </Button>

    <Button
      variant='secondary'
      className='mt-2 h-14 w-full text-body'
      onClick={onSkip}
      disabled={importing}
    >
      {importing ? 'importing...' : 'continue without a password'}
    </Button>
    <p className='text-center text-label text-fg-muted lowercase'>
      anyone using this computer can open zafu and see your balances
    </p>

    <Button variant='quiet' className='mt-2 w-full' onClick={onScanAgain} disabled={importing}>
      scan again
    </Button>
  </div>
);

type DetectedNet = 'penumbra' | 'zcash' | 'cosmos';

/** a payload that opens a multi-frame (fountain) UR sequence, e.g. a keystone export too large for one QR */
const MULTIPART_UR = /^ur:[^/]+\/\d+-\d+\//i;

/** one detail line per network for the scanned-account summary. */
function detailLine(
  net: DetectedNet,
  ctx: {
    walletImport: ReturnType<typeof zignerConnectSelector>['walletImport'];
    zcashWalletImport: ReturnType<typeof zignerConnectSelector>['zcashWalletImport'];
    parsedCosmosExport: ReturnType<typeof zignerConnectSelector>['parsedCosmosExport'];
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
              <span className='capitalize text-fg'>{a.chainId}:</span>{' '}
              <Clipped head={12} tail={8} label='address'>
                {a.address}
              </Clipped>
            </div>
          ))}
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
  const { addZignerUnencrypted } = useStore(keyRingSelector);
  const [importing, setImporting] = useState(false);
  // whether the scanner has upgraded to animated (multi-frame) mode
  const [multipart, setMultipart] = useState(false);

  // Hidden manual input mode - activated by clicking the title 10 times
  const clickCountRef = useRef(0);
  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const manualInputRef = useRef(false);

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

  // one camera for any signer: a single-frame code (legacy zigner QR, or a
  // one-shot UR) goes straight through processQrData; a code that opens a
  // multi-frame (fountain) UR sequence - keystone's animated export - swaps
  // the scanner itself into animated mode instead of asking which device
  // this is beforehand.
  const handleScan = useCallback(
    (data: string) => {
      if (MULTIPART_UR.test(data.trim())) {
        setMultipart(true);
        return;
      }
      processQrData(data);
    },
    [processQrData],
  );
  const handleManualInput = (value: string) => value.trim() && processQrData(value);

  // skip password - use default encryption
  const handleSkip = async () => {
    if (!walletImport && !zcashWalletImport && !parsedCosmosExport) {
      setError("please scan your signer's code first");
      return;
    }
    try {
      setImporting(true);
      // reachable from settings > zigner on an already set-up wallet (adding
      // another device) - "make it yours" is only for the first one
      const firstWallet = !(await localExtStorage.get('vaults'))?.length;
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
        const ufvk = zcashWalletImport.ufvk;
        const deviceId =
          zcashWalletImport.zidPublicKey ??
          (kind === 'keystone' && ufvk ? keystoneDeviceId(ufvk) : `zcash-${Date.now()}`);
        const defaultLabel = kind === 'keystone' ? 'keystone zcash' : 'zigner zcash';
        const zignerData: ZignerZafuImport = {
          viewingKey: ufvk,
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
      }
      if (firstWallet) {
        await setOnboardingValuesInStorage(SEED_PHRASE_ORIGIN.ZIGNER);
      }
      clearZignerState();
      navigate(firstWallet ? PagePath.PERSONALIZE : PagePath.ONBOARDING_SUCCESS);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`this wallet wasn't added · ${message}`);
    } finally {
      setImporting(false);
    }
  };

  const handleSetPassword = () => {
    if (!walletImport && !zcashWalletImport && !parsedCosmosExport) {
      setError("please scan your signer's code first");
      return;
    }
    navigate(PagePath.ZIGNER_PASSWORD);
  };

  const resetState = () => {
    clearZignerState();
    manualInputRef.current = false;
  };

  // Full-screen scanner mode - one camera. A code that needs several frames
  // (keystone's animated export) upgrades the same screen to animated mode
  // instead of asking beforehand which device this is.
  if (scanState === 'scanning') {
    if (multipart) {
      return (
        <AnimatedQrScanner
          onComplete={(bytes, urType) => {
            if (urType !== 'zcash-accounts') {
              setError(
                `this code isn't an account code (ur:${urType}) · please show the connect code on your signer`,
              );
              return;
            }
            processZcashAccountsBytes(bytes);
          }}
          onError={setError}
          onClose={() => {
            setMultipart(false);
            setScanState('idle');
          }}
          inline
          title='reading device code'
          description='hold the camera steady - this code spans several frames'
          urTypeFilter='zcash-accounts'
        />
      );
    }
    return (
      <QrScanner
        onScan={handleScan}
        onError={setError}
        onClose={() => setScanState('idle')}
        inline
        title='scan your device'
        description='zafu tells which one it is'
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
        })
      : null;

  return (
    <div className='flex flex-col gap-5'>
      {/* title doubles as the hidden manual-input trigger (10 clicks) */}
      <h1
        onClick={handleTitleClick}
        className='cursor-default font-display text-[38px] text-fg-high'
      >
        scan your device
      </h1>
      <p className='text-body text-fg-muted lowercase'>
        scan the connect code your cold signer shows - zafu tells which one it is.
      </p>

      {scanState === 'idle' && !showManualInput && (
        <div className='flex flex-col gap-2.5'>
          <div className='flex flex-col gap-2 border border-border-soft bg-elev-1 p-3'>
            {[
              { icon: 'i-ph-link', name: 'zigner', path: 'home › connect to zafu' },
              {
                icon: 'i-ph-qr-code',
                name: 'keystone',
                path: 'connect software wallet › zafu',
              },
            ].map(({ icon, name, path }) => (
              <span
                key={name}
                className='flex items-center gap-2 text-label text-fg-muted lowercase'
              >
                <span className={cn(icon, 'size-3.5 shrink-0 text-zigner-gold')} />
                <span className='text-fg-high'>{name}</span>
                {path}
              </span>
            ))}
          </div>

          <Button
            variant='primary'
            className='h-14 w-full text-body'
            onClick={() => {
              setMultipart(false);
              setScanState('scanning');
            }}
          >
            <span className='i-ph-scan mr-2 size-4' />
            scan a signer
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
              disabled={!walletImport && !zcashWalletImport && !parsedCosmosExport}
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
  );
};
