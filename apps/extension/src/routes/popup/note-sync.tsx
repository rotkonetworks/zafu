/**
 * note sync — transfer spendable notes to zigner via animated QR
 *
 * displays an animated QR code (BC-UR fountain-coded) containing
 * the wallet's spendable notes so the air-gapped zigner device
 * can display the correct balance and verify spend authorizations.
 */

import { useState, useEffect } from 'react';
import { useStore } from '../../state';
import { selectActiveZcashWallet } from '../../state/wallets';
import { selectEffectiveKeyInfo } from '../../state/keyring';
import { getNotesInWorker } from '../../state/keyring/network-worker';
import { encodeNoteSyncPayload, type SyncNote } from '@repo/wallet/zcash-zigner';
import { AnimatedQrDisplay } from '../../shared/components/animated-qr-display';
import { SettingsScreen } from './settings/settings-screen';
import { PopupPath } from './paths';

type Step = 'loading' | 'display' | 'error';

export const NoteSyncPage = () => {
  const activeWallet = useStore(selectActiveZcashWallet);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const [step, setStep] = useState<Step>('loading');
  const [payload, setPayload] = useState<Uint8Array | null>(null);
  const [noteCount, setNoteCount] = useState(0);
  const [balance, setBalance] = useState('0');
  const [error, setError] = useState('');

  // sync uses vaultId (selectedKeyInfo.id), not zcash wallet id
  const walletId = selectedKeyInfo?.id;

  useEffect(() => {
    if (!activeWallet || !walletId) {
      setError('no active zcash wallet');
      setStep('error');
      return;
    }

    void (async () => {
      try {
        const allNotes = await getNotesInWorker('zcash', walletId);

        // filter to unspent notes only
        const spendable = allNotes.filter(n => !n.spent);

        const syncNotes: SyncNote[] = spendable.map(n => ({
          height: n.height,
          value: n.value,
          nullifier: n.nullifier,
          cmx: n.cmx,
          position: n.position,
        }));

        // compute balance
        let total = 0n;
        for (const n of syncNotes) {
          total += BigInt(n.value);
        }

        const syncHeight = spendable.reduce((max, n) => Math.max(max, n.height), 0);
        const encoded = encodeNoteSyncPayload(syncNotes, syncHeight, activeWallet.mainnet);

        setPayload(encoded);
        setNoteCount(syncNotes.length);
        setBalance((Number(total) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
        setStep('display');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    })();
  }, [activeWallet]);

  return (
    <SettingsScreen title='sync to zigner' backPath={PopupPath.SETTINGS_WALLETS}>
      {step === 'loading' && (
        <div className='flex flex-col items-center gap-3 py-8'>
          <span className='i-lucide-loader-2 size-5 animate-spin text-muted-foreground' />
          <p className='text-xs text-muted-foreground'>loading notes...</p>
        </div>
      )}

      {step === 'display' && payload && activeWallet && (
        <div className='flex flex-col gap-4'>
          <div className='rounded-lg border border-border/40 bg-card p-3'>
            <p className='text-[10px] text-muted-foreground'>wallet</p>
            <p className='text-sm font-medium truncate'>{activeWallet.label}</p>
            <div className='mt-1 flex items-center gap-2'>
              <span className='text-lg font-mono font-medium'>{balance}</span>
              <span className='text-xs text-muted-foreground'>ZEC</span>
            </div>
            <p className='text-[10px] text-muted-foreground mt-1'>
              {noteCount} spendable note{noteCount !== 1 ? 's' : ''} · {payload.length.toLocaleString()} bytes
            </p>
          </div>

          <AnimatedQrDisplay
            data={payload}
            urType='zcash-notes'
            title='point zigner camera at this QR'
            description='the QR code cycles through multiple frames — hold the camera steady until zigner shows the balance'
          />
        </div>
      )}

      {step === 'display' && noteCount === 0 && (
        <div className='rounded-lg border border-border/40 bg-card p-3 text-xs text-muted-foreground'>
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
