/**
 * note sync — transfer spendable notes to zigner via animated QR
 *
 * builds merkle witnesses, encodes as CBOR (ur:zcash-notes),
 * and displays as UR-encoded animated QR for the air-gapped
 * zigner device to scan and verify.
 */

import { useState, useEffect } from 'react';
import { useStore } from '../../state';
import { selectActiveZcashWallet } from '../../state/wallets';
import { selectEffectiveKeyInfo } from '../../state/keyring';
import { encodeNoteSyncInWorker } from '../../state/keyring/network-worker';
import type { NoteSyncEncoded } from '../../state/keyring/network-worker';
import { AnimatedQrDisplay } from '../../shared/components/animated-qr-display';
import { SettingsScreen } from './settings/settings-screen';
import { PopupPath } from './paths';

type Step = 'loading' | 'building' | 'display' | 'error';

export const NoteSyncPage = () => {
  const activeWallet = useStore(selectActiveZcashWallet);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const [step, setStep] = useState<Step>('loading');
  const [encoded, setEncoded] = useState<NoteSyncEncoded | null>(null);
  const [error, setError] = useState('');

  const walletId = selectedKeyInfo?.id;
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';

  useEffect(() => {
    if (!activeWallet || !walletId) {
      setError('no active zcash wallet');
      setStep('error');
      return;
    }

    void (async () => {
      try {
        setStep('building');

        const serverUrl = zidecarUrl;

        const result = await encodeNoteSyncInWorker(
          'zcash',
          walletId,
          activeWallet.mainnet,
          serverUrl,
        );

        setEncoded(result);
        setStep('display');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    })();
  }, [activeWallet]);

  const balanceDisplay = encoded
    ? (Number(BigInt(encoded.balance)) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
    : '0';

  return (
    <SettingsScreen title='sync to zigner' backPath={PopupPath.SETTINGS_WALLETS}>
      {(step === 'loading' || step === 'building') && (
        <div className='flex flex-col items-center gap-3 py-8'>
          <span className='i-lucide-loader-2 size-5 animate-spin text-fg-muted' />
          <p className='text-xs text-fg-muted'>
            {step === 'loading' ? 'loading notes...' : 'building merkle witnesses...'}
          </p>
        </div>
      )}

      {step === 'display' && encoded && encoded.noteCount > 0 && activeWallet && (
        <div className='flex flex-col gap-4'>
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <p className='text-[10px] text-fg-muted'>wallet</p>
            <p className='text-sm font-medium truncate'>{activeWallet.label}</p>
            <div className='mt-1 flex items-center gap-2'>
              <span className='text-lg font-mono font-medium'>{balanceDisplay}</span>
              <span className='text-xs text-fg-muted'>ZEC</span>
            </div>
            <p className='text-[10px] text-fg-muted mt-1'>
              {encoded.noteCount} spendable note{encoded.noteCount !== 1 ? 's' : ''} · {encoded.cborBytes.toLocaleString()} bytes
            </p>
          </div>

          <AnimatedQrDisplay
            urFrames={encoded.frames}
            totalBytes={encoded.cborBytes}
            title='point zigner camera at this QR'
            description='the QR code cycles through multiple frames — hold the camera steady until zigner shows the balance'
          />
        </div>
      )}

      {step === 'display' && encoded && encoded.noteCount === 0 && (
        <div className='rounded-lg border border-border-soft bg-elev-1 p-3 text-xs text-fg-muted'>
          no spendable notes — sync the wallet first
        </div>
      )}

      {step === 'error' && (
        <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
          {error}
        </div>
      )}
    </SettingsScreen>
  );
};
