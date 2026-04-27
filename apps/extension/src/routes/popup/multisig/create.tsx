/**
 * create multisig wallet - DKG flow
 *
 * 1. choose threshold (t) and max signers (n)
 * 2. create room - show room code + QR for others to join
 * 3. run 3 DKG rounds via relay (automatic once all participants join)
 * 4. store key package + public key package as multisig wallet
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import {
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostDeriveAddressFromSkInWorker,
  frostSampleFvkSkInWorker,
  frostDeriveUfvkInWorker,
} from '../../../state/keyring/network-worker';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { QrDisplay } from '../../../shared/components/qr-display';

type Step =
  | 'config'
  | 'waiting'
  | 'dkg-round1'
  | 'dkg-round2'
  | 'dkg-round3'
  | 'fvk-echo'
  | 'complete'
  | 'error';

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
  const [participantCount, setParticipantCount] = useState(1); // self = 1
  // single end-to-end deadline for the whole DKG session (10 min total).
  // null while idle; set once `handleCreate` starts.
  const [deadline, setDeadline] = useState<number | null>(null);

  const startDkg = useStore(s => s.frostSession.startDkg);
  const resetDkg = useStore(s => s.frostSession.resetDkg);
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const countdown = useDeadlineCountdown(
    step === 'waiting' || step.startsWith('dkg-round') || step === 'fvk-echo'
      ? deadline
      : null,
  );

  const handleCreate = async () => {
    const abortController = new AbortController();
    // single deadline shared by every wait in this DKG session.
    const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
    setDeadline(sessionDeadline);
    try {
      const url = relayUrl || 'https://poker.zk.bot';
      const code = await startDkg(url, threshold, maxSigners);
      setRoomCode(code);
      setStep('waiting');
      setParticipantCount(1);

      // reuse the relay client that startDkg already created and joined.
      // opening a second `new FrostRelayClient(url)` here would put TWO
      // WebSocket connections from this tab into the room, inflating the
      // participant count, echoing our own broadcast back to us as a
      // "peer", and breaking dkg_part2 (which sees its own message in
      // the peer set and the parse fails).
      const relay = useStore.getState().frostSession.relay;
      if (!relay) throw new Error('frost relay missing — startDkg did not initialize it');

      setStep('dkg-round1');
      const round1 = await frostDkgPart1InWorker(maxSigners, threshold);

      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      const peerFvks: string[] = [];

      // host samples the nk/rivk-deriving `sk` and broadcasts it alongside
      // T:N in its own R1. every peer reconstructs the same UFVK locally
      // via frostDeriveUfvkInWorker(pkg, sk, mainnet). we echo-broadcast
      // the resulting UFVK after round 3 and abort on any mismatch —
      // that's what guards against a tampered broadcast.
      const fvkSk = await frostSampleFvkSkInWorker();

      // messages are tagged with their round at send time (R1: / R2: / FVK:)
      // so receivers bucket by sender's phase, not their own. a faster peer
      // could otherwise send round 2 before we left round 1 locally, and we'd
      // push the r2 package into peerBroadcasts. host additionally embeds
      // T:N:SK:<hex> in its r1 so fresh joiners can read the DKG params and
      // the shared fvk seed off the wire.
      let joined = false;
      void relay.joinRoom(
        code,
        participantId,
        event => {
          if (event.type === 'joined') {
            joined = true;
            setParticipantCount(event.participant.participantCount);
          } else if (event.type === 'message') {
            const text = new TextDecoder().decode(event.message.payload);
            // host form: R1:T:N:SK:<64-hex>:<broadcast>
            // peer form: R1:<broadcast>
            const r1 = text.match(/^R1:(?:(\d+):(\d+):SK:([0-9a-fA-F]{64}):)?([\s\S]*)$/);
            if (r1) {
              peerBroadcasts.push(r1[4]!);
              return;
            }
            const r2 = text.match(/^R2:([\s\S]*)$/);
            if (r2) {
              peerRound2.push(r2[1]!);
              return;
            }
            const fvk = text.match(/^FVK:([\s\S]*)$/);
            if (fvk) {
              peerFvks.push(fvk[1]!);
              return;
            }
            console.warn('[multisig-create] unknown frost message, dropping:', text.slice(0, 32));
          } else if (event.type === 'closed') {
            setError(`room closed: ${event.reason}`);
            setStep('error');
          }
        },
        abortController.signal,
      );

      // wait until we're joined before sending
      await waitForUntil(() => joined, sessionDeadline);

      // send our round1 broadcast — host embeds T:N + the fvk sk so joiners
      // can derive the identical UFVK locally
      const prefixedBroadcast = `R1:${threshold}:${maxSigners}:SK:${fvkSk}:${round1.broadcast}`;
      await relay.sendMessage(code, participantId, new TextEncoder().encode(prefixedBroadcast));

      await waitForUntil(() => peerBroadcasts.length >= maxSigners - 1, sessionDeadline);

      // diagnostic: log peer broadcasts before handing to FROST worker.
      // a "serialize: parse: invalid type: map" error here means one of these
      // strings isn't a valid hex-encoded SignedMessage.
      console.log(
        '[multisig-create] peerBroadcasts before part2:',
        peerBroadcasts.map((s, i) => ({
          i,
          len: s.length,
          head: s.slice(0, 32),
          looksHex: /^[0-9a-f]+$/i.test(s),
        })),
      );

      setStep('dkg-round2');
      const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);

      for (const pkg of round2.peer_packages) {
        await relay.sendMessage(code, participantId, new TextEncoder().encode(`R2:${pkg}`));
      }

      await waitForUntil(() => peerRound2.length >= maxSigners - 1, sessionDeadline);

      setStep('dkg-round3');
      const round3 = await frostDkgPart3InWorker(round2.secret, peerBroadcasts, peerRound2);

      // derive address + UFVK from the same (pkg, sk) pair so they share
      // one source of truth for nk/rivk. using the non-sk address derivation
      // here would produce per-participant random addresses even though the
      // UFVK agrees — wallet records would diverge silently.
      const addr = await frostDeriveAddressFromSkInWorker(round3.public_key_package, fvkSk, 0);
      setAddress(addr);

      const orchardFvk = await frostDeriveUfvkInWorker(round3.public_key_package, fvkSk, true);

      // echo-broadcast our UFVK, wait for every peer's echo, abort on any
      // mismatch. this catches a dishonest host (sending different sk to
      // different peers), a corrupted R1 broadcast, or any bug in local
      // derivation — all before we commit anything to storage.
      setStep('fvk-echo');
      await relay.sendMessage(code, participantId, new TextEncoder().encode(`FVK:${orchardFvk}`));
      await waitForUntil(() => peerFvks.length >= maxSigners - 1, sessionDeadline);
      for (const peerFvk of peerFvks) {
        if (peerFvk !== orchardFvk) {
          throw new Error(
            `FVK mismatch: peer saw a different viewing key — ` +
              `ours ends …${orchardFvk.slice(-8)}, theirs ends …${peerFvk.slice(-8)}`,
          );
        }
      }

      await newFrostMultisigKey({
        label: `${threshold}-of-${maxSigners} multisig`,
        address: addr,
        orchardFvk,
        keyPackage: round3.key_package,
        publicKeyPackage: round3.public_key_package,
        ephemeralSeed: round3.ephemeral_seed,
        threshold,
        maxSigners,
        relayUrl: url,
      });

      setStep('complete');
      resetDkg();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
      resetDkg();
    } finally {
      abortController.abort();
    }
  };

  const currentRound = step.startsWith('dkg-round') ? Number(step.replace('dkg-round', '')) : 0;

  return (
    <SettingsScreen title='create multisig' backPath={PopupPath.MULTISIG}>
      {step === 'config' && (
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
          <div className='flex gap-3'>
            <label className='flex-1 text-xs text-fg-muted'>
              threshold (t)
              <input
                type='number'
                className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                min={2}
                max={maxSigners}
              />
            </label>
            <label className='flex-1 text-xs text-fg-muted'>
              signers (n)
              <input
                type='number'
                className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
                value={maxSigners}
                onChange={e => setMaxSigners(Number(e.target.value))}
                min={threshold}
                max={255}
              />
            </label>
          </div>
          <p className='text-xs text-fg-muted'>
            {threshold}-of-{maxSigners}: requires {threshold} signatures to approve each transaction
          </p>
          <button
            className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-zigner-gold hover:bg-primary/10 transition-colors'
            onClick={() => void handleCreate()}
          >
            create room
          </button>
        </div>
      )}

      {step === 'waiting' && (
        <div className='flex flex-col items-center gap-4'>
          <p className='text-xs text-fg-muted'>share this room code with other participants</p>

          {/* room code + copy */}
          <div className='flex items-center gap-2 rounded-lg border border-border-soft bg-elev-1 px-6 py-4'>
            <span className='font-mono text-2xl tracking-wider'>{roomCode}</span>
            <button
              onClick={() => void navigator.clipboard.writeText(roomCode)}
              className='p-1 text-fg-muted hover:text-fg-high transition-colors'
            >
              <span className='i-lucide-copy size-4' />
            </button>
          </div>

          {/* QR code for room code */}
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <QrDisplay
              data={Array.from(new TextEncoder().encode(roomCode))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('')}
              size={160}
            />
          </div>

          {/* participant counter */}
          <div className='flex items-center gap-2 rounded-md bg-elev-2 px-3 py-1.5'>
            <span className='i-lucide-users size-3.5 text-fg-muted' />
            <span className='text-xs'>
              <span className='font-medium text-fg'>{participantCount}</span>
              <span className='text-fg-muted'> / {maxSigners} joined</span>
            </span>
          </div>

          {/* countdown + spinner */}
          <div className='flex items-center gap-2 text-xs text-fg-muted'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            waiting for {maxSigners - participantCount} participant(s)...
            <span className='tabular-nums text-fg-dim'>{countdown}s</span>
          </div>
        </div>
      )}

      {currentRound > 0 && (
        <div className='flex flex-col items-center gap-4'>
          <div className='flex items-center gap-2 text-xs text-fg-muted'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            {currentRound < 3
              ? `exchanging ${DKG_STEPS[currentRound - 1]?.label ?? ''}...`
              : 'finalizing...'}
            <span className='tabular-nums text-fg-dim'>{countdown}s</span>
          </div>

          {/* round progress */}
          <div className='flex gap-2'>
            {DKG_STEPS.map((s, i) => (
              <div key={s.key} className='flex items-center gap-1.5'>
                <div
                  className={`flex size-5 items-center justify-center rounded-full text-[10px] font-medium ${
                    i + 1 <= currentRound
                      ? 'bg-zigner-gold text-zigner-dark'
                      : 'bg-elev-2 text-fg-muted'
                  }`}
                >
                  {i + 1}
                </div>
                <span className={`text-xs ${i + 1 <= currentRound ? 'text-fg' : 'text-fg-muted'}`}>
                  {s.label}
                </span>
              </div>
            ))}
          </div>

          {/* participant counter */}
          <div className='flex items-center gap-2 rounded-md bg-elev-2 px-3 py-1.5'>
            <span className='i-lucide-users size-3.5 text-fg-muted' />
            <span className='text-xs'>
              <span className='font-medium text-fg'>{participantCount}</span>
              <span className='text-fg-muted'> / {maxSigners} participants</span>
            </span>
          </div>

          {roomCode && (
            <div className='flex items-center gap-2 rounded-lg border border-border-soft bg-elev-1 px-4 py-2'>
              <span className='font-mono text-sm tracking-wider'>{roomCode}</span>
              <button
                onClick={() => void navigator.clipboard.writeText(roomCode)}
                className='p-1 text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-copy size-3.5' />
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'fvk-echo' && (
        <div className='flex flex-col items-center gap-3'>
          <div className='flex items-center gap-2 text-xs text-fg-muted'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            verifying viewing key agreement...
            <span className='tabular-nums text-fg-dim'>{countdown}s</span>
          </div>
          <p className='text-[10px] text-fg-muted'>
            every participant must see the same UFVK before the wallet is saved
          </p>
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            multisig wallet created
          </div>
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <p className='text-[10px] text-fg-muted'>address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
          <p className='text-xs text-fg-muted'>
            {threshold}-of-{maxSigners} threshold. {threshold} participants must approve outgoing
            transactions.
          </p>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
            {error}
          </div>
          <button
            onClick={() => {
              setStep('config');
              setError('');
            }}
            className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
          >
            try again
          </button>
        </div>
      )}
    </SettingsScreen>
  );
};
