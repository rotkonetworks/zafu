/**
 * co-sign multisig transaction — join a signing session initiated by the coordinator
 *
 * 1. enter room code from coordinator
 * 2. receive SIGN:<sighash>:<alphas> prefix from coordinator
 * 3. run FROST round 1 (commitments) + round 2 (shares)
 * 4. coordinator aggregates — we're done
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import { selectActiveZcashWallet } from '../../../state/wallets';
import {
  frostSignRound1InWorker,
  frostSpendSignInWorker,
} from '../../../state/keyring/network-worker';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

type Step = 'input' | 'waiting' | 'signing' | 'complete' | 'error';

export const MultisigSign = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [txSummary, setTxSummary] = useState('');

  const activeWallet = useStore(selectActiveZcashWallet);
  const ms = activeWallet?.multisig;

  const handleSign = async () => {
    if (!roomCode.trim() || !ms) return;

    try {
      const relayUrl = (typeof ms.relayUrl === 'string' ? ms.relayUrl : '') || 'https://zidecar.rotko.net';
      setStep('waiting');
      setProgress('decrypting keys...');

      // decrypt secret key material
      const secrets = await useStore.getState().wallets.getMultisigSecrets(activeWallet!.id);
      if (!secrets) throw new Error('failed to decrypt multisig keys');

      setProgress('connecting to signing session...');

      const relay = new FrostRelayClient(relayUrl);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      // state for receiving coordinator data
      let sighash = '';
      let alphas: string[] = [];
      // coordinator sends pipe-delimited commitments (one per action)
      let peerCommitmentBundle: string[] | null = null;
      let phase: 'init' | 'commitments' | 'done' = 'init';

      const abortController = new AbortController();
      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (phase === 'init') {
            // format: SIGN:<sighash>:<alpha1,alpha2,...>:<summary>
            const signMatch = text.match(/^SIGN:([0-9a-fA-F]+):([^:]+):(.*)$/);
            if (signMatch) {
              sighash = signMatch[1]!;
              alphas = signMatch[2]!.split(',');
              setTxSummary(signMatch[3] || '');
              phase = 'commitments';
            }
            // if not SIGN prefix, ignore (don't misclassify as commitment)
          } else if (phase === 'commitments' && !peerCommitmentBundle) {
            // coordinator's commitment bundle: pipe-delimited, one per action
            peerCommitmentBundle = text.split('|');
          }
        }
      }, abortController.signal);

      // wait for SIGN prefix
      setProgress('waiting for transaction data...');
      await waitFor(() => sighash.length > 0, 120000);

      setStep('signing');
      const numActions = alphas.length;
      setProgress(`round 1: generating ${numActions} commitment(s)...`);

      // generate fresh nonces per action — NEVER reuse nonces across different messages
      const round1s: { nonces: string; commitments: string }[] = [];
      for (let i = 0; i < numActions; i++) {
        round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
      }

      // broadcast our commitments as pipe-delimited bundle
      const ourCommitments = round1s.map(r => r.commitments).join('|');
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(ourCommitments));

      // wait for coordinator's commitment bundle
      setProgress('round 1: waiting for coordinator...');
      await waitFor(() => peerCommitmentBundle !== null, 120000);

      // validate coordinator sent enough commitments
      if (peerCommitmentBundle!.length < numActions) {
        throw new Error(`coordinator sent ${peerCommitmentBundle!.length} commitments but ${numActions} actions needed`);
      }

      // round 2: sign each action with its dedicated nonces
      phase = 'done'; // stop collecting messages
      setProgress('round 2: signing...');

      for (let i = 0; i < numActions; i++) {
        setProgress(`round 2: signing action ${i + 1}/${numActions}...`);
        const allCommitments = [round1s[i]!.commitments, peerCommitmentBundle![i]!];
        const share = await frostSpendSignInWorker(
          secrets.keyPackage, round1s[i]!.nonces, sighash, alphas[i]!, allCommitments,
        );
        // tag share with action index so coordinator can bucket correctly
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(`S:${i}:${share}`));
      }

      abortController.abort();
      setStep('complete');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  if (!ms) {
    return (
      <SettingsScreen title='co-sign' backPath={PopupPath.SETTINGS_WALLETS}>
        <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
          no active multisig wallet — select a multisig wallet first
        </div>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title='co-sign' backPath={PopupPath.SETTINGS_WALLETS}>
      <div className='mb-4 rounded-lg border border-border/40 bg-card p-3'>
        <p className='text-[10px] text-muted-foreground'>signing as</p>
        <p className='mt-0.5 text-sm font-medium truncate'>{activeWallet.label}</p>
        <p className='text-[10px] font-mono text-muted-foreground truncate'>
          {activeWallet.address.slice(0, 16)}...{activeWallet.address.slice(-8)}
        </p>
        <span className='mt-1 inline-block rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary'>
          {ms.threshold}/{ms.maxSigners}
        </span>
      </div>

      {step === 'input' && (
        <div className='flex flex-col gap-4'>
          <label className='text-xs text-muted-foreground'>
            room code
            <input
              className='mt-1 w-full rounded-lg border border-border/40 bg-input px-3 py-2.5 font-mono text-sm focus:border-primary/50 focus:outline-none'
              value={roomCode}
              onChange={e => setRoomCode(e.target.value)}
              placeholder='acid-blue-cave'
              autoFocus
            />
          </label>
          <button
            className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-primary hover:bg-primary/10 transition-colors disabled:opacity-50'
            onClick={() => void handleSign()}
            disabled={!roomCode.trim()}
          >
            co-sign
          </button>
        </div>
      )}

      {(step === 'waiting' || step === 'signing') && (
        <div className='flex flex-col items-center gap-4'>
          {txSummary && (
            <div className='w-full rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3'>
              <p className='text-[10px] text-yellow-400'>signing transaction</p>
              <p className='mt-0.5 text-sm font-medium text-yellow-300'>{txSummary}</p>
            </div>
          )}
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            {progress}
          </div>
        </div>
      )}

      {step === 'complete' && (
        <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
          signing shares sent — coordinator will broadcast the transaction
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
            {error}
          </div>
          <button
            onClick={() => { setStep('input'); setError(''); }}
            className='rounded-lg border border-border/40 py-2 text-xs hover:bg-muted/50 transition-colors'
          >
            try again
          </button>
        </div>
      )}
    </SettingsScreen>
  );
};

const waitFor = (condition: () => boolean, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for signing data'));
      setTimeout(check, 500);
    };
    check();
  });
