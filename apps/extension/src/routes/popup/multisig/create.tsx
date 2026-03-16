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

type Step = 'config' | 'waiting' | 'dkg-round1' | 'dkg-round2' | 'dkg-round3' | 'complete' | 'error';

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
      // use the zidecar URL as relay URL (frost relay runs on same server)
      const url = relayUrl || 'https://zidecar.rotko.net';
      const code = await startDkg(url, threshold, maxSigners);
      setRoomCode(code);
      setStep('waiting');

      // start listening for participants
      const relay = new FrostRelayClient(url);

      // DKG round 1: generate our commitment
      setStep('dkg-round1');
      const round1 = await frostDkgPart1InWorker(maxSigners, threshold);

      // join the room with a placeholder participant ID
      // (the actual ed25519 pubkey is inside the signed broadcast)
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';

      // send our round1 broadcast
      await relay.sendMessage(code, participantId, new TextEncoder().encode(round1.broadcast));

      // listen for peer messages
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

      // wait for enough round1 broadcasts
      await waitFor(() => peerBroadcasts.length >= maxSigners - 1, 120000);

      // DKG round 2
      dkgPhase = 'round2';
      setStep('dkg-round2');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);

      // send round2 peer packages
      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(code, participantId, new TextEncoder().encode(pkg));
      }

      // wait for enough round2 packages
      await waitFor(() => peerRound2.length >= maxSigners - 1, 120000);

      // DKG round 3
      setStep('dkg-round3');
      const round3 = await frostDkgPart3InWorker(
        round2.secret,
        peerBroadcasts,
        peerRound2,
      );

      // derive address
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
      });

      setStep('complete');
      abortController.abort();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  return (
    <div className='flex flex-col gap-4 p-4'>
      <h2 className='font-headline text-lg'>Create Multisig Wallet</h2>

      {step === 'config' && (
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
          <div className='flex gap-3'>
            <label className='flex-1 text-sm text-muted-foreground'>
              Threshold (t)
              <input
                type='number'
                className='mt-1 w-full rounded bg-muted p-2 text-sm'
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                min={2}
                max={maxSigners}
              />
            </label>
            <label className='flex-1 text-sm text-muted-foreground'>
              Signers (n)
              <input
                type='number'
                className='mt-1 w-full rounded bg-muted p-2 text-sm'
                value={maxSigners}
                onChange={e => setMaxSigners(Number(e.target.value))}
                min={threshold}
                max={255}
              />
            </label>
          </div>
          <p className='text-xs text-muted-foreground'>
            {threshold}-of-{maxSigners}: requires {threshold} participants to approve each transaction
          </p>
          <button
            className='rounded bg-primary p-2 text-primary-foreground'
            onClick={handleCreate}
          >
            Create Room
          </button>
        </div>
      )}

      {step === 'waiting' && (
        <div className='flex flex-col items-center gap-3'>
          <p className='text-sm text-muted-foreground'>Share this room code with other participants:</p>
          <div className='rounded bg-muted px-6 py-3 font-mono text-xl'>{roomCode}</div>
          <p className='text-xs text-muted-foreground'>Waiting for {maxSigners - 1} other participant(s) to join...</p>
          <div className='h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent' />
        </div>
      )}

      {(step === 'dkg-round1' || step === 'dkg-round2' || step === 'dkg-round3') && (
        <div className='flex flex-col items-center gap-3'>
          <p className='text-sm'>
            {step === 'dkg-round1' && 'DKG Round 1: Exchanging commitments...'}
            {step === 'dkg-round2' && 'DKG Round 2: Exchanging key shares...'}
            {step === 'dkg-round3' && 'DKG Round 3: Finalizing key generation...'}
          </p>
          <div className='flex gap-1'>
            {[1, 2, 3].map(r => (
              <div
                key={r}
                className={`h-2 w-8 rounded-full ${
                  r <= Number(step.replace('dkg-round', ''))
                    ? 'bg-primary'
                    : 'bg-muted'
                }`}
              />
            ))}
          </div>
          <div className='h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent' />
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded bg-green-900/30 p-3 text-sm text-green-400'>
            Multisig wallet created successfully!
          </div>
          <div className='rounded bg-muted p-3'>
            <p className='text-xs text-muted-foreground'>Address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
          <p className='text-xs text-muted-foreground'>
            {threshold}-of-{maxSigners} threshold. All participants can view incoming transactions.
            {threshold} participants must approve outgoing transactions.
          </p>
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
