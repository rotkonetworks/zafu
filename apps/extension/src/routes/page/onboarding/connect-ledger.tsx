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
  connectLedgerBtc,
  getLedgerZcashTransparentAddress,
  isLedgerBtcSupported,
  zcashTransparentPath,
} from '../../../ledger/hw-btc-signer';

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
  /** Stable dedup key: `ledger-btc-<t-address>` (the t-address is deterministic
   *  for a given device seed + path). */
  readonly deviceId: string;
  /** the account's transparent (t1.../tm...) address, read from the device. */
  readonly transparentAddress: string;
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
  const supported = isLedgerBtcSupported();

  const handleBack = () => navigate(-1);

  const handleConnect = useCallback(async () => {
    setError(null);
    setPhase('connecting');
    try {
      // Bitcoin-app (hw-app-btc) transparent path - the only Ledger route that
      // signs Zcash on mainnet today. Read the t-address, then release the
      // transport; the send flow reopens it with a fresh user gesture.
      const transport = await connectLedgerBtc();
      try {
        const { address } = await getLedgerZcashTransparentAddress(
          transport,
          zcashTransparentPath(0),
        );
        // Deterministic per device seed + path, so the t-address doubles as the
        // stable dedup key.
        setAccount({ deviceId: `ledger-btc-${address}`, transparentAddress: address });
        setPhase('connected');
      } finally {
        await transport.close();
      }
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
        // Transparent-only account: the t-address is both the receive address
        // and the spend source; no unified address / ufvk.
        address: account.transparentAddress,
        transparentAddress: account.transparentAddress,
        accountIndex: 0,
        deviceId: account.deviceId,
        mainnet: MAINNET,
      };
      await addLedgerUnencrypted(ledgerImport, walletLabel || 'ledger (transparent)');
      await setOnboardingValuesInStorage(SEED_PHRASE_ORIGIN.LEDGER);
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
            <NoticeBox tone='warn' icon='i-ph-arrow-square-out'>
              open zafu in the side panel or a full tab to connect a ledger. usb sessions are
              dropped when the popup loses focus.
            </NoticeBox>
          )}

          {!inPopup && !supported && (
            <NoticeBox tone='warn' icon='i-ph-warning'>
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
                    <span className='i-ph-circle-notch mr-2 h-4 w-4 animate-spin' />
                    connecting...
                  </>
                ) : (
                  <>
                    <span className='i-ph-usb mr-2 h-4 w-4' />
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
                </div>
                <div className='mt-1 font-mono text-xs text-fg-muted break-all'>
                  <span className='text-fg-muted/70'>transparent: </span>
                  {account.transparentAddress}
                </div>
              </div>

              <Input
                placeholder='wallet label'
                value={walletLabel}
                onChange={e => setWalletLabel(e.target.value)}
              />

              {/* Update-app alert. hw-app-btc signs against the Zcash app on the
                  device; an app that predates NU6.3 does not know the current
                  consensus branch id and REJECTS every send (6a80). Tell the user
                  to update before they try to send, or it fails on-device. */}
              <NoticeBox tone='warn' icon='i-ph-arrows-clockwise'>
                update your ledger zcash app to the latest version in ledger live first. an older
                app does not recognise the current zcash network and will reject transparent sends.
              </NoticeBox>

              {/* TRANSPARENT-ONLY. zafu signs Ledger via the Bitcoin app (the only
                  path that works on mainnet today); the dedicated shielded app is
                  not published yet, so shielded on Ledger is unavailable REGARDLESS
                  of app version. State that plainly - do not imply shielded works. */}
              <NoticeBox tone='warn' icon='i-ph-shield-slash'>
                ledger is transparent-only in zafu right now. you can send and receive transparent
                zec (t-addresses). shielded on ledger needs a newer zcash app from ledger and is
                coming later - keep long-term savings in a shielded zafu wallet.
              </NoticeBox>

              <NoticeBox tone='info' icon='i-ph-usb'>
                watch-only + transparent. view your t-address balance and sign transparent sends
                with the ledger plugged in.
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
