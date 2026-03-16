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

  const activeWallet = useStore(selectActiveZcashWallet);
  const ms = activeWallet?.multisig;

  const handleSign = async () => {
    if (!roomCode.trim() || !ms) return;

    try {
      const relayUrl = ms.relayUrl || 'https://zidecar.rotko.net';
      setStep('waiting');
      setProgress('connecting to signing session...');

      const relay = new FrostRelayClient(relayUrl);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      // state for receiving coordinator data
      let sighash = '';
      let alphas: string[] = [];
      const peerCommitments: string[] = [];
      let phase: 'init' | 'commitments' | 'shares' | 'done' = 'init';

      const abortController = new AbortController();
      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (phase === 'init') {
            // parse SIGN:<sighash>:<alpha1>,<alpha2>,... prefix from coordinator
            const signMatch = text.match(/^SIGN:([0-9a-fA-F]+):(.+)$/);
            if (signMatch) {
              sighash = signMatch[1]!;
              alphas = signMatch[2]!.split(',');
              phase = 'commitments';
            } else {
              // this is a commitment (coordinator sent SIGN before we joined)
              peerCommitments.push(text);
              phase = 'commitments';
            }
          } else if (phase === 'commitments') {
            peerCommitments.push(text);
          }
          // shares phase: we only produce shares, coordinator collects
        }
      }, abortController.signal);

      // wait for SIGN prefix
      setProgress('waiting for transaction data...');
      await waitFor(() => sighash.length > 0, 120000);

      setStep('signing');
      setProgress('round 1: generating commitments...');

      // round 1: generate nonces + commitments
      const round1 = await frostSignRound1InWorker(ms.ephemeralSeed, ms.keyPackage);

      // broadcast our commitments
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(round1.commitments));

      // wait for coordinator's commitments (at least 1 peer = coordinator)
      setProgress('round 1: waiting for coordinator...');
      await waitFor(() => peerCommitments.length >= 1, 120000);

      // all commitments = ours + peers
      const allCommitments = [round1.commitments, ...peerCommitments];

      // round 2: produce shares for each action (alpha)
      phase = 'shares';
      setProgress('round 2: signing...');

      for (let i = 0; i < alphas.length; i++) {
        setProgress(`round 2: signing action ${i + 1}/${alphas.length}...`);
        const share = await frostSpendSignInWorker(
          ms.keyPackage, round1.nonces, sighash, alphas[i]!, allCommitments,
        );
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(share));
      }

      phase = 'done';
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
