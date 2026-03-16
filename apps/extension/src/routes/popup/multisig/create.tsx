/**
 * create multisig wallet — DKG flow
 *
 * 1. choose threshold (t) and max signers (n)
 * 2. create room → show room code for others to join
 * 3. run 3 DKG rounds via relay (automatic once all participants join)
 * 4. store key package + public key package as multisig wallet
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import {
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostDeriveAddressInWorker,
} from '../../../state/keyring/network-worker';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

type Step = 'config' | 'waiting' | 'dkg-round1' | 'dkg-round2' | 'dkg-round3' | 'complete' | 'error';

const DKG_STEPS = [
  { key: 'dkg-round1', label: 'commitments' },
  { key: 'dkg-round2', label: 'key shares' },
  { key: 'dkg-round3', label: 'finalize' },
] as const;

export const MultisigCreate = () => {
  const [threshold, setThreshold] = useState(2);
  const [maxSigners, setMaxSigners] = useState(3);
  const [step, setStep] = useState<Step>('config');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [relayUrl, setRelayUrl] = useState('');

  const startDkg = useStore(s => s.frostSession.startDkg);
  const addMultisigWallet = useStore(s => s.wallets.addMultisigWallet);

  const handleCreate = async () => {
    try {
      const url = relayUrl || 'https://zidecar.rotko.net';
      const code = await startDkg(url, threshold, maxSigners);
      setRoomCode(code);
      setStep('waiting');

      const relay = new FrostRelayClient(url);

      setStep('dkg-round1');
      const round1 = await frostDkgPart1InWorker(maxSigners, threshold);

      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';

      // send our round1 broadcast with DKG params prefix so joiners learn threshold/maxSigners
      const prefixedBroadcast = `DKG:${threshold}:${maxSigners}:${round1.broadcast}`;
      await relay.sendMessage(code, participantId, new TextEncoder().encode(prefixedBroadcast));

      const abortController = new AbortController();
      void relay.joinRoom(code, participantId, (event) => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (dkgPhase === 'round1') {
            peerBroadcasts.push(text);
          } else if (dkgPhase === 'round2') {
            peerRound2.push(text);
          }
        }
      }, abortController.signal);

      await waitFor(() => peerBroadcasts.length >= maxSigners - 1, 120000);

      dkgPhase = 'round2';
      setStep('dkg-round2');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);

      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(code, participantId, new TextEncoder().encode(pkg));
      }

      await waitFor(() => peerRound2.length >= maxSigners - 1, 120000);

      setStep('dkg-round3');
      const round3 = await frostDkgPart3InWorker(
        round2.secret,
        peerBroadcasts,
        peerRound2,
      );

      const addr = await frostDeriveAddressInWorker(round3.public_key_package, 0);
      setAddress(addr);

      await addMultisigWallet({
        label: `${threshold}-of-${maxSigners} multisig`,
        address: addr,
        keyPackage: round3.key_package,
        publicKeyPackage: round3.public_key_package,
        ephemeralSeed: round3.ephemeral_seed,
        threshold,
        maxSigners,
        relayUrl: url,
      });

      setStep('complete');
      abortController.abort();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const currentRound = step.startsWith('dkg-round') ? Number(step.replace('dkg-round', '')) : 0;

  return (
    <SettingsScreen title='create multisig' backPath={PopupPath.SETTINGS_WALLETS}>
      {step === 'config' && (
        <div className='flex flex-col gap-4'>
          <label className='text-xs text-muted-foreground'>
            relay url
            <input
              className='mt-1 w-full rounded-lg border border-border/40 bg-input px-3 py-2.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
              value={relayUrl}
              onChange={e => setRelayUrl(e.target.value)}
              placeholder='https://zidecar.rotko.net'
            />
          </label>
          <div className='flex gap-3'>
            <label className='flex-1 text-xs text-muted-foreground'>
              threshold (t)
              <input
                type='number'
                className='mt-1 w-full rounded-lg border border-border/40 bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                min={2}
                max={maxSigners}
              />
            </label>
            <label className='flex-1 text-xs text-muted-foreground'>
              signers (n)
              <input
                type='number'
                className='mt-1 w-full rounded-lg border border-border/40 bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
                value={maxSigners}
                onChange={e => setMaxSigners(Number(e.target.value))}
                min={threshold}
                max={255}
              />
            </label>
          </div>
          <p className='text-xs text-muted-foreground'>
            {threshold}-of-{maxSigners}: requires {threshold} signatures to approve each transaction
          </p>
          <button
            className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-primary hover:bg-primary/10 transition-colors'
            onClick={() => void handleCreate()}
          >
            create room
          </button>
        </div>
      )}

      {step === 'waiting' && (
        <div className='flex flex-col items-center gap-4'>
          <p className='text-xs text-muted-foreground'>share this room code with other participants</p>
          <div className='flex items-center gap-2 rounded-lg border border-border/40 bg-card px-6 py-4'>
            <span className='font-mono text-2xl tracking-wider'>{roomCode}</span>
            <button
              onClick={() => void navigator.clipboard.writeText(roomCode)}
              className='p-1 text-muted-foreground hover:text-foreground transition-colors'
            >
              <span className='i-lucide-copy size-4' />
            </button>
          </div>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            waiting for {maxSigners - 1} participant(s)...
          </div>
        </div>
      )}

      {currentRound > 0 && (
        <div className='flex flex-col items-center gap-4'>
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            key generation in progress
          </div>
          <div className='flex gap-2'>
            {DKG_STEPS.map((s, i) => (
              <div key={s.key} className='flex items-center gap-1.5'>
                <div className={`flex size-5 items-center justify-center rounded-full text-[10px] font-medium ${
                  i + 1 <= currentRound
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}>
                  {i + 1}
                </div>
                <span className={`text-xs ${i + 1 <= currentRound ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {s.label}
                </span>
              </div>
            ))}
          </div>
          {roomCode && (
            <div className='flex items-center gap-2 rounded-lg border border-border/40 bg-card px-4 py-2'>
              <span className='font-mono text-sm tracking-wider'>{roomCode}</span>
              <button
                onClick={() => void navigator.clipboard.writeText(roomCode)}
                className='p-1 text-muted-foreground hover:text-foreground transition-colors'
              >
                <span className='i-lucide-copy size-3.5' />
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            multisig wallet created
          </div>
          <div className='rounded-lg border border-border/40 bg-card p-3'>
            <p className='text-[10px] text-muted-foreground'>address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
          <p className='text-xs text-muted-foreground'>
            {threshold}-of-{maxSigners} threshold. {threshold} participants must approve outgoing transactions.
          </p>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
            {error}
          </div>
          <button
            onClick={() => setStep('config')}
            className='rounded-lg border border-border/40 py-2 text-xs hover:bg-muted/50 transition-colors'
          >
            try again
          </button>
        </div>
      )}
    </SettingsScreen>
  );
};

/** poll until condition is true, with timeout */
const waitFor = (condition: () => boolean, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for participants'));
      setTimeout(check, 500);
    };
    check();
  });
