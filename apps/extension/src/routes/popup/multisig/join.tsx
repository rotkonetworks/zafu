/**
 * join multisig wallet - DKG flow from the joiner's perspective
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
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
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
  const [participantCount, setParticipantCount] = useState(0);
  const [maxSigners, setMaxSignersDisplay] = useState(0);
  // single end-to-end deadline for the whole DKG session (10 min total)
  const [deadline, setDeadline] = useState<number | null>(null);
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const countdown = useDeadlineCountdown(
    step === 'joining' || step === 'dkg' ? deadline : null,
  );

  const handleJoin = async () => {
    if (!roomCode.trim()) return;

    const abortController = new AbortController();
    const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
    setDeadline(sessionDeadline);
    try {
      const url = relayUrl || 'https://poker.zk.bot';
      setStep('joining');

      const relay = new FrostRelayClient(url);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      let threshold = 0;
      let maxSignersLocal = 0;
      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];

      setStep('dkg');
      setProgress('waiting for coordinator...');

      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'joined') {
          setParticipantCount(event.participant.participantCount);
        } else if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          // messages are tagged with their round (R1: / R2:) so we bucket by
          // sender's phase, not ours. a faster peer could otherwise send its
          // r2 packages before we leave r1 locally and we'd misfile them.
          const r1 = text.match(/^R1:(?:(\d+):(\d+):)?([\s\S]*)$/);
          if (r1) {
            if (r1[1] && r1[2]) {
              // host's r1 carries T:N so we learn the DKG params off the wire
              threshold = Number(r1[1]);
              maxSignersLocal = Number(r1[2]);
              setThresholdInfo(`${threshold}-of-${maxSignersLocal}`);
              setMaxSignersDisplay(maxSignersLocal);
            }
            peerBroadcasts.push(r1[3]!);
            return;
          }
          const r2 = text.match(/^R2:([\s\S]*)$/);
          if (r2) {
            peerRound2.push(r2[1]!);
            return;
          }
          console.warn('[multisig-join] unknown frost message, dropping:', text.slice(0, 32));
        } else if (event.type === 'closed') {
          setError(`room closed: ${event.reason}`);
          setStep('error');
        }
      }, abortController.signal);

      await waitForUntil(() => threshold > 0 && maxSignersLocal > 0, sessionDeadline);
      setProgress('round 1: generating commitment...');

      const round1 = await frostDkgPart1InWorker(maxSignersLocal, threshold);
      // diagnostic: confirm the broadcast we send is a hex string (the format
      // dkg_part2 expects). a non-hex value here is the source of the
      // "invalid type: map" error on the peer side.
      console.log('[multisig-join] sending round1.broadcast:',
        { len: round1.broadcast.length, head: round1.broadcast.slice(0, 32), looksHex: /^[0-9a-f]+$/i.test(round1.broadcast) });
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(`R1:${round1.broadcast}`));

      setProgress(`round 1: waiting for ${maxSignersLocal - 1} participant(s)...`);
      await waitForUntil(() => peerBroadcasts.length >= maxSignersLocal - 1, sessionDeadline);

      setProgress('round 2: exchanging key shares...');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(`R2:${pkg}`));
      }

      setProgress(`round 2: waiting for ${maxSignersLocal - 1} peer package(s)...`);
      await waitForUntil(() => peerRound2.length >= maxSignersLocal - 1, sessionDeadline);

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
    <SettingsScreen title='join multisig' backPath={PopupPath.MULTISIG}>
      {step === 'input' && (
        <div className='flex flex-col gap-4'>
          <label className='text-xs text-fg-muted'>
            relay url
            <input
              className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 font-mono text-xs focus:border-primary/50 focus:outline-none'
              value={relayUrl}
              onChange={e => setRelayUrl(e.target.value)}
              placeholder='https://poker.zk.bot'
            />
          </label>
          <label className='text-xs text-fg-muted'>
            room code
            <input
              className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 font-mono text-sm focus:border-primary/50 focus:outline-none'
              value={roomCode}
              onChange={e => setRoomCode(e.target.value)}
              placeholder='acid-blue-cave'
              autoFocus
            />
          </label>
          <button
            className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-zigner-gold hover:bg-primary/10 transition-colors disabled:opacity-50'
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
            <span className='rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-zigner-gold'>
              {thresholdInfo}
            </span>
          )}

          {/* participant counter */}
          {maxSigners > 0 && (
            <div className='flex items-center gap-2 rounded-md bg-elev-2 px-3 py-1.5'>
              <span className='i-lucide-users size-3.5 text-fg-muted' />
              <span className='text-xs'>
                <span className='font-medium text-fg'>{participantCount}</span>
                <span className='text-fg-muted'> / {maxSigners} joined</span>
              </span>
            </div>
          )}

          <div className='flex items-center gap-2 text-xs text-fg-muted'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            {progress || 'connecting...'}
            <span className='tabular-nums text-fg-dim'>{countdown}s</span>
          </div>
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            joined multisig wallet
          </div>
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <p className='text-[10px] text-fg-muted'>address</p>
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
            className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
          >
            try again
          </button>
        </div>
      )}
    </SettingsScreen>
  );
};
