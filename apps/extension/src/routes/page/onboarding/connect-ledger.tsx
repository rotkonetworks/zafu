/**
 * Ledger hardware-wallet connect - onboarding.
 *
 * Modelled on `import-zigner.tsx`, but the cold key material arrives over
 * WebHID instead of a scanned QR. The Ledger stays plugged in and signs over
 * USB; what we import here is watch-only (address + ufvk), exactly like the
 * zigner airgap import.
 *
 * CONTEXT NOTE - must run in a persistent page context. WebHID sessions die
 * the moment the extension popup loses focus (the device permission is scoped
 * to the surviving document, and the popup is torn down on blur). So this flow
 * has to be opened in the SIDE PANEL or a DEDICATED TAB, never the toolbar
 * popup - otherwise `connectLedger()` will resolve against a document that is
 * about to be destroyed and every subsequent HID transfer throws. The card in
 * start.tsx routes here; onboarding already renders inside page.html (a real
 * tab), and we additionally guard below with isPopup() so a stray popup entry
 * bails out with instructions rather than silently failing.
 *
 * Gated behind HARDWARE_WALLET_ENABLED - the entry card in start.tsx is
 * filtered out while the flag is off, so this screen is unreachable from the UI
 * until the flag flips (the route stays registered for type-checking).
 */

import { useCallback, useState } from 'react';
import { BackIcon } from '@repo/ui/components/ui/icons/back-icon';
import { Button } from '@repo/ui/components/ui/button';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { Input } from '@repo/ui/components/ui/input';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { keyRingSelector, type LedgerImport } from '../../../state/keyring';
import { usePageNav } from '../../../utils/navigate';
import { isPopup } from '../../../utils/popup-detection';
import { PagePath } from '../paths';
import { setOnboardingValuesInStorage } from './persist-parameters';
import { SEED_PHRASE_ORIGIN } from './password/types';
import {
  isLedgerSupported,
  connectLedger,
  getLedgerAccount,
  ledgerCapabilities,
} from '../../../ledger';

/** Zcash mainnet - onboarding only imports the mainnet account today. */
const MAINNET = true;

// Version -> capability decisions come from the single source `ledgerCapabilities`
// (../../../ledger/capabilities): transparent always; shielded iff app >= 3.8.0.

/**
 * Small access/notice box - same visual language as import-zigner's AccessNote,
 * but ledger notices carry a warn or info tone depending on capability.
 */
const NoticeBox = ({ tone, icon, children }: NoticeBoxProps) => (
  <div
    className={cn(
      'flex items-start gap-1.5 rounded-lg border p-3 text-left text-xs lowercase',
      tone === 'warn'
        ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-400'
        : 'border-border-soft/60 bg-elev-2/40 text-fg-muted',
    )}
  >
    <span className={cn(icon, 'mt-0.5 h-3.5 w-3.5 shrink-0')} />
    <span>{children}</span>
  </div>
);

interface NoticeBoxProps {
  readonly tone: 'warn' | 'info';
  readonly icon: string;
  readonly children: React.ReactNode;
}

/** Local view state - a small linear machine, no store slice needed. */
type Phase = 'idle' | 'connecting' | 'connected' | 'importing';

interface Connected {
  readonly deviceId: string;
  readonly appVersion: string;
  readonly address: string;
  readonly ufvk: string | undefined;
}

export const ConnectLedger = () => {
  const navigate = usePageNav();
  const { addLedgerUnencrypted } = useStore(keyRingSelector);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [walletLabel, setWalletLabel] = useState('');
  const [account, setAccount] = useState<Connected | null>(null);

  // WebHID must not run in the toolbar popup (see file header). Onboarding is
  // already a real tab, so this only trips if someone deep-links the route into
  // a popup - bail with guidance instead of a cryptic HID failure.
  const inPopup = isPopup();
  const supported = isLedgerSupported();

  const handleBack = () => navigate(-1);

  const handleConnect = useCallback(async () => {
    setError(null);
    setPhase('connecting');
    try {
      const { sessionId, appVersion } = await connectLedger();
      // Ledger has no stable per-wallet id we can read cheaply; the WebHID
      // session id is stable for the lifetime of this connection and is what
      // the ledger module keys transfers on, so use it as the deviceId.
      const deviceId = `ledger-${sessionId}`;
      const { address, ufvk } = await getLedgerAccount(0, MAINNET);
      setAccount({ deviceId, appVersion, address, ufvk });
      setPhase('connected');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`failed to connect ledger: ${message}`);
      setPhase('idle');
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!account) {
      return;
    }
    setError(null);
    setPhase('importing');
    try {
      const ledgerImport: LedgerImport = {
        address: account.address,
        ufvk: account.ufvk,
        accountIndex: 0,
        deviceId: account.deviceId,
        mainnet: MAINNET,
      };
      await addLedgerUnencrypted(ledgerImport, walletLabel || 'ledger zcash');
      // Mirror the zigner completion path so the success screen and background
      // services see the same onboarding side-effects (rpc/frontend/numeraires).
      await setOnboardingValuesInStorage(SEED_PHRASE_ORIGIN.ZIGNER);
      navigate(PagePath.ONBOARDING_SUCCESS);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`failed to import: ${message}`);
      setPhase('connected');
    }
  }, [account, addLedgerUnencrypted, walletLabel, navigate]);

  return (
    <FadeTransition>
      <div className='flex h-full flex-col gap-6'>
        <header className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <BackIcon onClick={handleBack} />
            <h2 className='text-2xl lowercase tracking-[-0.01em] text-fg-high'>connect ledger</h2>
          </div>
          <p className='text-xs text-fg-muted lowercase'>
            plug in your ledger and open the zcash app to add a watch-only wallet.
          </p>
        </header>

        <div className='flex flex-col gap-4'>
          {inPopup && (
            <NoticeBox tone='warn' icon='i-lucide-external-link'>
              open zafu in the side panel or a full tab to connect a ledger. usb sessions are
              dropped when the popup loses focus.
            </NoticeBox>
          )}

          {!inPopup && !supported && (
            <NoticeBox tone='warn' icon='i-lucide-triangle-alert'>
              this browser does not support webhid. use a chromium browser to connect a ledger.
            </NoticeBox>
          )}

          {/* idle - connect button */}
          {!inPopup && supported && phase !== 'connected' && phase !== 'importing' && (
            <div className='flex flex-col gap-2.5'>
              <Button
                variant='gradient'
                className='w-full'
                disabled={phase === 'connecting'}
                onClick={handleConnect}
              >
                {phase === 'connecting' ? (
                  <>
                    <span className='i-lucide-loader-circle mr-2 h-4 w-4 animate-spin' />
                    connecting...
                  </>
                ) : (
                  <>
                    <span className='i-lucide-usb mr-2 h-4 w-4' />
                    connect ledger
                  </>
                )}
              </Button>
              {error && <div className='mt-1 text-sm text-red-400'>{error}</div>}
            </div>
          )}

          {/* connected - account detail + import */}
          {(phase === 'connected' || phase === 'importing') && account && (
            <div className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1'>
                <div className='text-title text-fg-high lowercase tracking-[-0.005em]'>
                  ledger connected
                </div>
                <div className='font-mono text-xs text-fg-muted break-all'>
                  account #0
                  <span className='ml-2'>(mainnet)</span>
                  <span className='ml-2'>app v{account.appVersion}</span>
                </div>
                <div className='mt-1 font-mono text-xs text-fg-muted break-all'>
                  {account.address}
                </div>
              </div>

              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              {/* Capability notices. Transparent-only (no ufvk) is the common
                  case for older ledger app builds; call it out plainly. */}
              {account.ufvk === undefined && (
                <NoticeBox tone='warn' icon='i-lucide-eye-off'>
                  this ledger app version exposes only a transparent address; shielded balance
                  unavailable.
                </NoticeBox>
              )}

              {/* what the connected app version can do (current app in, ready for
                  future): transparent always; shielded gates on app >= 3.8.0. */}
              {ledgerCapabilities(account.appVersion).shielded ? (
                <NoticeBox tone='info' icon='i-lucide-shield-check'>
                  shielded supported - hold and spend shielded on ledger.
                </NoticeBox>
              ) : (
                <NoticeBox tone='warn' icon='i-lucide-shield-off'>
                  ledger app older than 3.8.0 - transparent works now (sweep into a shielded
                  wallet); update the zcash app to hold shielded on ledger.
                </NoticeBox>
              )}

              <NoticeBox tone='info' icon='i-lucide-usb'>
                watch-only. view balances and build transactions; signing needs your ledger plugged
                in.
              </NoticeBox>

              {error && <div className='text-sm text-red-400'>{error}</div>}

              <div className='flex flex-col gap-2'>
                <Button
                  variant='gradient'
                  className='w-full'
                  disabled={phase === 'importing'}
                  onClick={handleImport}
                >
                  {phase === 'importing' ? 'importing...' : 'add wallet'}
                </Button>
                <Button
                  variant='ghost'
                  className='w-full'
                  disabled={phase === 'importing'}
                  onClick={() => {
                    setAccount(null);
                    setError(null);
                    setPhase('idle');
                  }}
                >
                  connect a different ledger
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </FadeTransition>
  );
};
