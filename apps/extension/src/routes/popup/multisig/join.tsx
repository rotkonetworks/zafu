/**
 * join multisig wallet - DKG flow from the joiner's perspective
 *
 * 1. enter room code from coordinator
 * 2. join relay room, run DKG rounds alongside coordinator
 * 3. store key package + public key package as multisig wallet
 */

import { useState, useEffect, useRef } from 'react';
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

const ROUND_TIMEOUT_MS = 120_000;

function useCountdown(active: boolean, totalMs: number) {
  const [remaining, setRemaining] = useState(Math.ceil(totalMs / 1000));
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (!active) {
      setRemaining(Math.ceil(totalMs / 1000));
      startRef.current = Date.now();
      return;
    }
    startRef.current = Date.now();
    const iv = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const left = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
      setRemaining(left);
    }, 1000);
    return () => clearInterval(iv);
  }, [active, totalMs]);

  return remaining;
}

export const MultisigJoin = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [thresholdInfo, setThresholdInfo] = useState('');
  const [participantCount, setParticipantCount] = useState(0);
  const [maxSigners, setMaxSignersDisplay] = useState(0);
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const isActive = step === 'joining' || step === 'dkg';
  const countdown = useCountdown(isActive, ROUND_TIMEOUT_MS);

  const handleJoin = async () => {
    if (!roomCode.trim()) return;

    const abortController = new AbortController();
    try {
      const url = relayUrl || 'https://zcash.rotko.net';
      setStep('joining');

      const relay = new FrostRelayClient(url);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      let threshold = 0;
      let maxSignersLocal = 0;
      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';

      setStep('dkg');
      setProgress('waiting for coordinator...');

      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'joined') {
          setParticipantCount(event.participant.participantCount);
        } else if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (dkgPhase === 'round1') {
            const dkgMatch = text.match(/^DKG:(\d+):(\d+):([\s\S]*)$/);
            if (dkgMatch) {
              threshold = Number(dkgMatch[1]);
              maxSignersLocal = Number(dkgMatch[2]);
              setThresholdInfo(`${threshold}-of-${maxSignersLocal}`);
              setMaxSignersDisplay(maxSignersLocal);
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

      await waitFor(() => threshold > 0 && maxSignersLocal > 0, ROUND_TIMEOUT_MS);
      setProgress('round 1: generating commitment...');

      const round1 = await frostDkgPart1InWorker(maxSignersLocal, threshold);
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(round1.broadcast));

      setProgress(`round 1: waiting for ${maxSignersLocal - 1} participant(s)...`);
      await waitFor(() => peerBroadcasts.length >= maxSignersLocal - 1, ROUND_TIMEOUT_MS);

      dkgPhase = 'round2';
      setProgress('round 2: exchanging key shares...');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(pkg));
      }

      setProgress(`round 2: waiting for ${maxSignersLocal - 1} peer package(s)...`);
      await waitFor(() => peerRound2.length >= maxSignersLocal - 1, ROUND_TIMEOUT_MS);

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
        label: `${threshold}-of-${maxSignersLocal} multisig`,
        address: addr,
        keyPackage: round3.key_package,
        publicKeyPackage: round3.public_key_package,
        ephemeralSeed: round3.ephemeral_seed,
        threshold,
        maxSigners: maxSignersLocal,
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
              placeholder='https://zcash.rotko.net'
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

          {/* participant counter */}
          {maxSigners > 0 && (
            <div className='flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5'>
              <span className='i-lucide-users size-3.5 text-muted-foreground' />
              <span className='text-xs'>
                <span className='font-medium text-foreground'>{participantCount}</span>
                <span className='text-muted-foreground'> / {maxSigners} joined</span>
              </span>
            </div>
          )}

          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            {progress || 'connecting...'}
            <span className='tabular-nums text-muted-foreground/60'>{countdown}s</span>
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
