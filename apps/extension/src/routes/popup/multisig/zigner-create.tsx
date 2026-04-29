/**
 * QR-mediated FROST DKG host flow for zigner-imported wallets.
 *
 * zafu drives the FROST relay (WSS); zigner runs the FROST math.
 * Each round is a QR round-trip: zafu shows a JSON trigger, user
 * scans with zigner, zigner displays a response QR, user scans back.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../state';
import {
  frostDeriveAddressFromSkInWorker,
  frostDeriveUfvkInWorker,
  frostSampleFvkSkInWorker,
} from '../../../state/keyring/network-worker';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

type Step =
  | 'config'
  | 'waiting-room'
  | 'dkg1-show'
  | 'dkg1-scan'
  | 'waiting-r1'
  | 'dkg2-show'
  | 'dkg2-scan'
  | 'waiting-r2'
  | 'dkg3-show'
  | 'dkg3-scan'
  | 'fvk-echo'
  | 'complete'
  | 'error';

export const MultisigCreateZigner = () => {
  const [threshold, setThreshold] = useState(2);
  const [maxSigners, setMaxSigners] = useState(3);
  const [relayUrl, setRelayUrl] = useState('');
  const [step, setStep] = useState<Step>('config');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [participantCount, setParticipantCount] = useState(1);
  const [publicKeyPackage, setPublicKeyPackage] = useState('');
  const [walletId, setWalletId] = useState('');
  // orchardFvk + address are state because slice 5 reads them at the save call
  const [, setOrchardFvk] = useState('');
  const [address, setAddress] = useState('');
  const [deadline, setDeadline] = useState<number | null>(null);

  // mutable accumulators — relay event handler pushes here, polling
  // useEffects read .length. Refs avoid render churn on every relay msg.
  const participantIdRef = useRef<Uint8Array | null>(null);
  const fvkSkRef = useRef('');
  const peerR1Ref = useRef<string[]>([]);
  const peerR2Ref = useRef<string[]>([]);
  const peerFvksRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const startDkg = useStore(s => s.frostSession.startDkg);
  const resetDkg = useStore(s => s.frostSession.resetDkg);
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const countdown = useDeadlineCountdown(
    step === 'waiting-room' || step.startsWith('dkg') || step === 'fvk-echo' || step.startsWith('waiting')
      ? deadline
      : null,
  );

  const dkg1Trigger = JSON.stringify({
    frost: 'dkg1',
    t: threshold,
    n: maxSigners,
    label: `${threshold}-of-${maxSigners} multisig`,
    mainnet: true,
  });

  // dkg2/dkg3 triggers reference the live ref arrays. They need to
  // stringify *at render time* of the show step, so we recompute on
  // every render rather than memoizing.
  const dkg2Trigger = JSON.stringify({
    frost: 'dkg2',
    broadcasts: peerR1Ref.current,
  });
  const dkg3Trigger = JSON.stringify({
    frost: 'dkg3',
    r1: peerR1Ref.current,
    r2: peerR2Ref.current,
  });

  const handleStart = async () => {
    try {
      const url = relayUrl || 'https://poker.zk.bot';
      const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
      setDeadline(sessionDeadline);

      const sk = await frostSampleFvkSkInWorker();
      fvkSkRef.current = sk;

      const code = await startDkg(url, threshold, maxSigners);
      setRoomCode(code);

      const relay = useStore.getState().frostSession.relay;
      if (!relay) throw new Error('frost relay missing — startDkg did not initialize it');

      const pid = new Uint8Array(32);
      crypto.getRandomValues(pid);
      participantIdRef.current = pid;

      abortRef.current = new AbortController();

      void relay.joinRoom(code, pid, event => {
        if (event.type === 'joined') {
          setParticipantCount(event.participant.participantCount);
        } else if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          // host's own R1 carries T:N:SK:<hex>: prefix; joiners' don't.
          // we strip the prefix and bucket the bare broadcast hex.
          const r1 = text.match(/^R1:(?:(\d+):(\d+):SK:([0-9a-fA-F]{64}):)?([\s\S]*)$/);
          if (r1) { peerR1Ref.current.push(r1[4]!); return; }
          const r2 = text.match(/^R2:([\s\S]*)$/);
          if (r2) { peerR2Ref.current.push(r2[1]!); return; }
          const fvk = text.match(/^FVK:([\s\S]*)$/);
          if (fvk) { peerFvksRef.current.push(fvk[1]!); return; }
        } else if (event.type === 'closed') {
          setError(`room closed: ${event.reason}`);
          setStep('error');
        }
      }, abortRef.current.signal);

      setStep('waiting-room');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  // r1 ack: zigner displays a binary QR containing either the bare hex
  // broadcast or — when zigner pre-decodes the hex to halve QR size — the
  // raw bytes of the SignedMessage JSON. Either way we normalize to the
  // hex shape the relay expects.
  const onZignerR1 = async (raw: string) => {
    try {
      if (raw.length === 0) throw new Error('empty r1 ack');
      const broadcastHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
        ? raw
        : Array.from(new TextEncoder().encode(raw))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
      const relay = useStore.getState().frostSession.relay;
      if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
      const prefixed = `R1:${threshold}:${maxSigners}:SK:${fvkSkRef.current}:${broadcastHex}`;
      await relay.sendMessage(roomCode, participantIdRef.current, new TextEncoder().encode(prefixed));
      setStep('waiting-r1');
    } catch (e) {
      setError(`r1 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  // r2 ack: zigner displays JSON.stringify(peer_packages) where peer_packages
  // is the WASM frost_dkg_part2 string[] result — same shape zafu's mnemonic
  // flow iterates as `R2:<pkg>` per element.
  const onZignerR2 = async (raw: string) => {
    try {
      const packages = JSON.parse(raw) as unknown;
      if (!Array.isArray(packages) || !packages.every(p => typeof p === 'string')) {
        throw new Error('expected JSON string array');
      }
      const relay = useStore.getState().frostSession.relay;
      if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
      for (const pkg of packages) {
        await relay.sendMessage(roomCode, participantIdRef.current, new TextEncoder().encode(`R2:${pkg}`));
      }
      setStep('waiting-r2');
    } catch (e) {
      setError(`r2 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  // r3 ack uses an envelope because there's no parallel in zafu's mnemonic
  // flow — we need both the public key package AND a label to disambiguate
  // it from the bare-hex r1 ack.
  const onZignerR3 = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as {
        frost?: string;
        public_key_package?: string;
        wallet_id?: string;
      };
      if (parsed.frost !== 'r3' || !parsed.public_key_package || !parsed.wallet_id) {
        throw new Error('not an r3 ack');
      }
      setPublicKeyPackage(parsed.public_key_package);
      setWalletId(parsed.wallet_id);
      setStep('fvk-echo');
    } catch (e) {
      setError(`r3 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  // auto-advance from waiting-room when everyone has joined
  useEffect(() => {
    if (step === 'waiting-room' && participantCount >= maxSigners) {
      setStep('dkg1-show');
    }
  }, [step, participantCount, maxSigners]);

  // auto-advance when peer R1 broadcasts arrive (n-1 expected)
  useEffect(() => {
    if (step !== 'waiting-r1' || !deadline) return;
    let cancelled = false;
    void waitForUntil(() => peerR1Ref.current.length >= maxSigners - 1, deadline)
      .then(() => { if (!cancelled) setStep('dkg2-show'); })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      });
    return () => { cancelled = true; };
  }, [step, maxSigners, deadline]);

  // auto-advance when peer R2 packages arrive ((n-1)² expected)
  useEffect(() => {
    if (step !== 'waiting-r2' || !deadline) return;
    let cancelled = false;
    void waitForUntil(() => peerR2Ref.current.length >= (maxSigners - 1) ** 2, deadline)
      .then(() => { if (!cancelled) setStep('dkg3-show'); })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      });
    return () => { cancelled = true; };
  }, [step, maxSigners, deadline]);

  // FVK echo: derive UFVK + address from public_key_package + sk,
  // broadcast on relay, wait for n-1 peer FVKs, abort on mismatch
  useEffect(() => {
    if (step !== 'fvk-echo' || !deadline || !publicKeyPackage) return;
    let cancelled = false;
    void (async () => {
      try {
        const ufvk = await frostDeriveUfvkInWorker(publicKeyPackage, fvkSkRef.current, true);
        const addr = await frostDeriveAddressFromSkInWorker(publicKeyPackage, fvkSkRef.current, 0);
        if (cancelled) return;

        const relay = useStore.getState().frostSession.relay;
        if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
        await relay.sendMessage(roomCode, participantIdRef.current, new TextEncoder().encode(`FVK:${ufvk}`));

        await waitForUntil(() => peerFvksRef.current.length >= maxSigners - 1, deadline);
        for (const peerFvk of peerFvksRef.current) {
          if (peerFvk !== ufvk) {
            throw new Error(
              `FVK mismatch: ours …${ufvk.slice(-8)}, theirs …${peerFvk.slice(-8)}`,
            );
          }
        }

        if (cancelled) return;
        // persist as airgapSigner — public bits only; share lives on zigner
        await newFrostMultisigKey({
          label: `${threshold}-of-${maxSigners} multisig`,
          address: addr,
          orchardFvk: ufvk,
          publicKeyPackage,
          threshold,
          maxSigners,
          relayUrl: relayUrl || 'https://poker.zk.bot',
          custody: 'airgapSigner',
        });

        setOrchardFvk(ufvk);
        setAddress(addr);
        setStep('complete');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [step, deadline, publicKeyPackage, maxSigners, roomCode, threshold, relayUrl, newFrostMultisigKey]);

  // teardown on unmount: abort relay subscription, drop dkg state
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      resetDkg();
    };
  }, [resetDkg]);

  return (
    <SettingsScreen title='create multisig (zigner)' backPath={PopupPath.MULTISIG}>
      {step === 'config' && (
        <div className='flex flex-col gap-4'>
          <div className='rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-2.5 text-[10px] text-yellow-400'>
            cold-multisig: the FROST share will be generated and stored on
            zigner only. zafu keeps only the public key package + UFVK.
          </div>
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
          <button
            className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-zigner-gold hover:bg-primary/10 transition-colors'
            onClick={() => void handleStart()}
          >
            create room
          </button>
        </div>
      )}

      {step === 'waiting-room' && (
        <div className='flex flex-col items-center gap-4'>
          <p className='text-xs text-fg-muted'>share this code with peers</p>
          <div className='font-mono text-2xl tracking-wider'>{roomCode}</div>
          <div className='flex items-center gap-2 rounded-md bg-elev-2 px-3 py-1.5'>
            <span className='i-lucide-users size-3.5 text-fg-muted' />
            <span className='text-xs'>
              <span className='font-medium text-fg'>{participantCount}</span>
              <span className='text-fg-muted'> / {maxSigners} joined</span>
            </span>
          </div>
          <span className='text-[10px] text-fg-muted tabular-nums'>{countdown}s</span>
        </div>
      )}

      {step === 'dkg1-show' && (
        <ScreenWithTriggerQr
          headline='round 1 of 3'
          body='Scan with zigner to start DKG round 1.'
          triggerJson={dkg1Trigger}
          nextLabel='scan zigner response'
          onNext={() => setStep('dkg1-scan')}
        />
      )}

      {step === 'dkg1-scan' && (
        <ScanZignerResponse
          title='scan zigner round-1 broadcast'
          onScan={raw => void onZignerR1(raw)}
          onCancel={() => setStep('dkg1-show')}
        />
      )}

      {step === 'waiting-r1' && (
        <WaitingForRelay
          headline='round 1 sent'
          body={`waiting for ${maxSigners - 1} peer R1 broadcast(s)…`}
          countdown={countdown}
        />
      )}

      {step === 'dkg2-show' && (
        <ScreenWithTriggerQr
          headline='round 2 of 3'
          body='Scan with zigner to compute R2 packages.'
          triggerJson={dkg2Trigger}
          nextLabel='scan zigner response'
          onNext={() => setStep('dkg2-scan')}
        />
      )}

      {step === 'dkg2-scan' && (
        <ScanZignerResponse
          title='scan zigner round-2 packages'
          onScan={raw => void onZignerR2(raw)}
          onCancel={() => setStep('dkg2-show')}
        />
      )}

      {step === 'waiting-r2' && (
        <WaitingForRelay
          headline='round 2 sent'
          body={`waiting for ${(maxSigners - 1) ** 2} peer R2 package(s)…`}
          countdown={countdown}
        />
      )}

      {step === 'dkg3-show' && (
        <ScreenWithTriggerQr
          headline='round 3 of 3'
          body='Scan with zigner to finalize and store the share.'
          triggerJson={dkg3Trigger}
          nextLabel='scan zigner ack'
          onNext={() => setStep('dkg3-scan')}
        />
      )}

      {step === 'dkg3-scan' && (
        <ScanZignerResponse
          title='scan zigner r3 ack (public_key_package)'
          onScan={onZignerR3}
          onCancel={() => setStep('dkg3-show')}
        />
      )}

      {step === 'fvk-echo' && (
        <div className='flex flex-col items-center gap-3'>
          <p className='text-xs text-fg-muted'>verifying viewing key agreement…</p>
          <span className='i-lucide-loader-2 size-4 animate-spin text-fg-muted' />
          <p className='text-[10px] text-fg-muted tabular-nums'>{countdown}s</p>
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            multisig wallet saved — share lives on zigner only
          </div>
          <div className='rounded-lg border border-border-soft bg-elev-1 p-3'>
            <p className='text-[10px] text-fg-muted'>address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
          <p className='text-[10px] text-fg-muted'>
            zigner wallet_id: <span className='font-mono'>{walletId}</span>
          </p>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
            {error}
          </div>
          <button
            onClick={() => { setStep('config'); setError(''); resetDkg(); }}
            className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
          >
            try again
          </button>
        </div>
      )}

    </SettingsScreen>
  );
};

// ── small inline helpers (kept local; promote to shared if joiner reuses) ──

interface TriggerProps {
  headline: string;
  body: string;
  triggerJson: string;
  nextLabel: string;
  onNext: () => void;
}

const TRIGGER_UR_TYPE = 'zafu-frost-dkg';

const ScreenWithTriggerQr = ({ headline, body, triggerJson, nextLabel, onNext }: TriggerProps) => {
  const bytes = new TextEncoder().encode(triggerJson);
  return (
    <div className='flex flex-col items-center gap-3'>
      <p className='text-xs text-fg-muted'>{headline}</p>
      <p className='text-[10px] text-fg-muted text-center max-w-xs'>{body}</p>
      <AnimatedQrDisplay data={bytes} urType={TRIGGER_UR_TYPE} size={200} />
      <button
        className='rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-zigner-gold'
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </div>
  );
};

interface ScanProps {
  title: string;
  onScan: (raw: string) => void;
  onCancel: () => void;
}

// AnimatedQrScanner reassembles multi-frame P-frame QR sequences and yields
// the original bytes. Decode UTF-8 → string and hand to per-round handler.
const ScanZignerResponse = ({ title, onScan, onCancel }: ScanProps) => (
  <AnimatedQrScanner
    inline
    title={title}
    onComplete={(data) => onScan(new TextDecoder().decode(data))}
    onClose={onCancel}
  />
);

const WaitingForRelay = ({ headline, body, countdown }: { headline: string; body: string; countdown: number | null }) => (
  <div className='flex flex-col items-center gap-3'>
    <p className='text-xs text-fg-muted'>{headline}</p>
    <p className='text-[10px] text-fg-muted text-center'>{body}</p>
    <span className='i-lucide-loader-2 size-4 animate-spin text-fg-muted' />
    {countdown != null && (
      <span className='text-[10px] text-fg-muted tabular-nums'>{countdown}s</span>
    )}
  </div>
);
