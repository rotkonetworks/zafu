/**
 * join multisig wallet — DKG flow from the joiner's perspective
 *
 * 1. enter room code from coordinator
 * 2. join relay room, run DKG rounds alongside coordinator
 * 3. store key package + public key package as multisig wallet
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

type Step = 'input' | 'joining' | 'dkg' | 'complete' | 'error';

export const MultisigJoin = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [thresholdInfo, setThresholdInfo] = useState('');
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const handleJoin = async () => {
    if (!roomCode.trim()) return;

    const abortController = new AbortController();
    try {
      const url = relayUrl || 'https://zidecar.rotko.net';
      setStep('joining');

      const relay = new FrostRelayClient(url);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      // we don't know threshold/maxSigners yet — coordinator's first message has DKG:<t>:<n>: prefix
      let threshold = 0;
      let maxSigners = 0;
      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';

      setStep('dkg');
      setProgress('waiting for coordinator...');

      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (dkgPhase === 'round1') {
            // coordinator's first broadcast has DKG:<threshold>:<maxSigners>: prefix
            const dkgMatch = text.match(/^DKG:(\d+):(\d+):([\s\S]*)$/);
            if (dkgMatch) {
              threshold = Number(dkgMatch[1]);
              maxSigners = Number(dkgMatch[2]);
              setThresholdInfo(`${threshold}-of-${maxSigners}`);
              peerBroadcasts.push(dkgMatch[3]!);
            } else {
              peerBroadcasts.push(text);
            }
          } else if (dkgPhase === 'round2') {
            peerRound2.push(text);
          }
        } else if (event.type === 'closed') {
          setError(`room closed: ${event.reason}`);
          setStep('error');
        }
      }, abortController.signal);

      // wait until we learn params from the coordinator's DKG prefix
      await waitFor(() => threshold > 0 && maxSigners > 0, 120000);
      setProgress('round 1: generating commitment...');

      // DKG round 1
      const round1 = await frostDkgPart1InWorker(maxSigners, threshold);
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(round1.broadcast));

      setProgress(`round 1: waiting for ${maxSigners - 1} participant(s)...`);
      await waitFor(() => peerBroadcasts.length >= maxSigners - 1, 120000);

      // DKG round 2
      dkgPhase = 'round2';
      setProgress('round 2: exchanging key shares...');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(pkg));
      }

      setProgress(`round 2: waiting for ${maxSigners - 1} peer package(s)...`);
      await waitFor(() => peerRound2.length >= maxSigners - 1, 120000);

      // DKG round 3
      dkgPhase = 'done';
      setProgress('round 3: finalizing...');
      const round3 = await frostDkgPart3InWorker(
        round2.secret,
        peerBroadcasts,
        peerRound2,
      );

      const addr = await frostDeriveAddressInWorker(round3.public_key_package, 0);
      setAddress(addr);

      await newFrostMultisigKey({
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      abortController.abort();
    }
  };

  return (
    <SettingsScreen title='join multisig' backPath={PopupPath.SETTINGS_WALLETS}>
      {step === 'input' && (
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
            onClick={() => void handleJoin()}
            disabled={!roomCode.trim()}
          >
            join
          </button>
        </div>
      )}

      {(step === 'joining' || step === 'dkg') && (
        <div className='flex flex-col items-center gap-4'>
          {thresholdInfo && (
            <span className='rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary'>
              {thresholdInfo}
            </span>
          )}
          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            {progress || 'connecting...'}
          </div>
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            joined multisig wallet
          </div>
          <div className='rounded-lg border border-border/40 bg-card p-3'>
            <p className='text-[10px] text-muted-foreground'>address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
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
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for participants'));
      setTimeout(check, 500);
    };
    check();
  });
