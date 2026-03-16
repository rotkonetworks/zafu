/**
 * join multisig wallet — DKG flow from the joiner's perspective
 *
 * 1. enter room code from coordinator
 * 2. join relay room, run DKG rounds alongside coordinator
 * 3. store key package + public key package as multisig wallet
 */

import { useState } from 'react';
import {
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostDeriveAddressInWorker,
} from '../../../state/keyring/network-worker';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';

type Step = 'input' | 'joining' | 'dkg' | 'complete' | 'error';

export const MultisigJoin = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState('');
  const [relayUrl, setRelayUrl] = useState('');

  const handleJoin = async () => {
    if (!roomCode.trim()) return;

    try {
      const url = relayUrl || 'https://zidecar.rotko.net';
      setStep('joining');

      const relay = new FrostRelayClient(url);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      // we don't know threshold/maxSigners yet — we'll learn from the room
      let threshold = 0;
      let maxSigners = 0;
      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';

      setStep('dkg');
      setProgress('Round 1: generating commitment...');

      // start DKG round 1 with placeholder params (will be overridden by room info)
      // join room first to learn params
      const abortController = new AbortController();
      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'joined') {
          if (!maxSigners) {
            maxSigners = event.participant.maxSigners;
            threshold = Math.max(2, Math.floor(maxSigners * 2 / 3)); // reasonable default
          }
        } else if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (dkgPhase === 'round1') {
            peerBroadcasts.push(text);
          } else if (dkgPhase === 'round2') {
            peerRound2.push(text);
          }
        } else if (event.type === 'closed') {
          setError(`room closed: ${event.reason}`);
          setStep('error');
        }
      }, abortController.signal);

      // wait a moment for room info
      await new Promise(r => setTimeout(r, 1000));
      if (!maxSigners) maxSigners = 3;
      if (!threshold) threshold = 2;

      // DKG round 1
      const round1 = await frostDkgPart1InWorker(maxSigners, threshold);
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(round1.broadcast));

      setProgress(`Round 1: waiting for ${maxSigners - 1} other participant(s)...`);
      await waitFor(() => peerBroadcasts.length >= maxSigners - 1, 120000);

      // DKG round 2
      dkgPhase = 'round2';
      setProgress('Round 2: exchanging key shares...');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(pkg));
      }

      setProgress(`Round 2: waiting for ${maxSigners - 1} peer package(s)...`);
      await waitFor(() => peerRound2.length >= maxSigners - 1, 120000);

      // DKG round 3
      dkgPhase = 'done';
      setProgress('Round 3: finalizing...');
      const round3 = await frostDkgPart3InWorker(
        round2.secret,
        peerBroadcasts,
        peerRound2,
      );

      const addr = await frostDeriveAddressInWorker(round3.public_key_package, 0);
      setAddress(addr);

      // TODO: store as multisig wallet in IDB

      setStep('complete');
      abortController.abort();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  return (
    <div className='flex flex-col gap-4 p-4'>
      <h2 className='font-headline text-lg'>Join Multisig Wallet</h2>

      {step === 'input' && (
        <div className='flex flex-col gap-3'>
          <label className='text-sm text-muted-foreground'>
            Relay URL
            <input
              className='mt-1 w-full rounded bg-muted p-2 text-sm'
              value={relayUrl}
              onChange={e => setRelayUrl(e.target.value)}
              placeholder='https://zidecar.rotko.net'
            />
          </label>
          <label className='text-sm text-muted-foreground'>
            Room Code
            <input
              className='mt-1 w-full rounded bg-muted p-2 font-mono text-sm'
              value={roomCode}
              onChange={e => setRoomCode(e.target.value)}
              placeholder='acid-blue-cave'
              autoFocus
            />
          </label>
          <button
            className='rounded bg-primary p-2 text-primary-foreground'
            onClick={handleJoin}
            disabled={!roomCode.trim()}
          >
            Join
          </button>
        </div>
      )}

      {(step === 'joining' || step === 'dkg') && (
        <div className='flex flex-col items-center gap-3'>
          <p className='text-sm'>{progress || 'Connecting to room...'}</p>
          <div className='h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent' />
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded bg-green-900/30 p-3 text-sm text-green-400'>
            Successfully joined multisig wallet!
          </div>
          <div className='rounded bg-muted p-3'>
            <p className='text-xs text-muted-foreground'>Address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
        </div>
      )}

      {step === 'error' && (
        <div className='rounded bg-red-900/30 p-3 text-sm text-red-400'>
          {error}
        </div>
      )}
    </div>
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
