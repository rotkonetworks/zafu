/**
 * QR-mediated FROST DKG joiner flow for zigner-imported wallets.
 *
 * Mirrors zigner-create.tsx but bootstraps T/N/sk from the host's
 * R1 broadcast (parsed off the relay) rather than from a config form.
 * Joiner's R1 broadcast does NOT carry the T:N:SK prefix.
 */

import { useEffect, useRef, useState } from 'react';
import {
  frostDeriveAddressFromSkInWorker,
  frostDeriveUfvkInWorker,
} from '../../../state/keyring/network-worker';
import { useStore } from '../../../state';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';

type Step =
  | 'input'
  | 'waiting-host-r1'
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

const utf8ToHex = (s: string): string =>
  Array.from(new TextEncoder().encode(s))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

export const MultisigJoinZigner = () => {
  const [relayUrl, setRelayUrl] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [participantCount, setParticipantCount] = useState(0);

  // bootstrap from host's R1 (parsed off the wire)
  const [threshold, setThreshold] = useState(0);
  const [maxSigners, setMaxSigners] = useState(0);

  const [publicKeyPackage, setPublicKeyPackage] = useState('');
  const [walletId, setWalletId] = useState('');
  const [, setOrchardFvk] = useState('');
  const [address, setAddress] = useState('');
  const [deadline, setDeadline] = useState<number | null>(null);

  const participantIdRef = useRef<Uint8Array | null>(null);
  const fvkSkRef = useRef('');
  const peerR1Ref = useRef<string[]>([]);
  const peerR2Ref = useRef<string[]>([]);
  const peerFvksRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const relayRef = useRef<FrostRelayClient | null>(null);

  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const countdown = useDeadlineCountdown(
    step === 'waiting-host-r1' || step.startsWith('dkg') || step === 'fvk-echo' || step.startsWith('waiting')
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

  const dkg2Trigger = JSON.stringify({
    frost: 'dkg2',
    broadcasts: peerR1Ref.current,
  });
  const dkg3Trigger = JSON.stringify({
    frost: 'dkg3',
    r1: peerR1Ref.current,
    r2: peerR2Ref.current,
  });

  const handleJoin = async () => {
    if (!roomCode.trim()) return;
    try {
      const url = relayUrl || 'https://poker.zk.bot';
      const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
      setDeadline(sessionDeadline);

      const relay = new FrostRelayClient(url);
      relayRef.current = relay;

      const pid = new Uint8Array(32);
      crypto.getRandomValues(pid);
      participantIdRef.current = pid;

      abortRef.current = new AbortController();

      void relay.joinRoom(roomCode.trim(), pid, event => {
        if (event.type === 'joined') {
          setParticipantCount(event.participant.participantCount);
        } else if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          // host R1 carries T:N:SK prefix; joiners' do not. parse the
          // first one we see to bootstrap T/N/sk; bucket the bare
          // broadcast hex either way.
          const r1 = text.match(/^R1:(?:(\d+):(\d+):SK:([0-9a-fA-F]{64}):)?([\s\S]*)$/);
          if (r1) {
            if (r1[1] && r1[2] && r1[3] && fvkSkRef.current === '') {
              setThreshold(Number(r1[1]));
              setMaxSigners(Number(r1[2]));
              fvkSkRef.current = r1[3];
            }
            peerR1Ref.current.push(r1[4]!);
            return;
          }
          const r2 = text.match(/^R2:([\s\S]*)$/);
          if (r2) { peerR2Ref.current.push(r2[1]!); return; }
          const fvk = text.match(/^FVK:([\s\S]*)$/);
          if (fvk) { peerFvksRef.current.push(fvk[1]!); return; }
        } else if (event.type === 'closed') {
          setError(`room closed: ${event.reason}`);
          setStep('error');
        }
      }, abortRef.current.signal);

      setStep('waiting-host-r1');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  // r1 ack: zigner may send bare hex or pre-decoded JSON bytes (binary-QR
  // optimization). Normalize to hex for the relay.
  const onZignerR1 = async (raw: string) => {
    try {
      if (raw.length === 0) throw new Error('empty r1 ack');
      const broadcastHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
        ? raw
        : Array.from(new TextEncoder().encode(raw))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
      const relay = relayRef.current;
      if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
      await relay.sendMessage(roomCode.trim(), participantIdRef.current, new TextEncoder().encode(`R1:${broadcastHex}`));
      setStep('waiting-r1');
    } catch (e) {
      setError(`r1 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  // r2 ack: JSON.stringify(peer_packages) — string[] from WASM frost_dkg_part2
  const onZignerR2 = async (raw: string) => {
    try {
      const packages = JSON.parse(raw) as unknown;
      if (!Array.isArray(packages) || !packages.every(p => typeof p === 'string')) {
        throw new Error('expected JSON string array');
      }
      const relay = relayRef.current;
      if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
      for (const pkg of packages) {
        await relay.sendMessage(roomCode.trim(), participantIdRef.current, new TextEncoder().encode(`R2:${pkg}`));
      }
      setStep('waiting-r2');
    } catch (e) {
      setError(`r2 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  // r3 ack uses an envelope so we can carry both public_key_package and wallet_id
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

  // auto-advance from waiting-host-r1 once we've parsed T/N/sk off it
  useEffect(() => {
    if (step !== 'waiting-host-r1' || !deadline) return;
    let cancelled = false;
    void waitForUntil(
      () => threshold > 0 && maxSigners > 0 && fvkSkRef.current.length === 64,
      deadline,
    )
      .then(() => { if (!cancelled) setStep('dkg1-show'); })
      .catch(e => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      });
    return () => { cancelled = true; };
  }, [step, threshold, maxSigners, deadline]);

  // wait for n-1 peer R1 broadcasts (joiner counts host + other joiners)
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

  // wait for (n-1)² peer R2 packages
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

  // FVK echo: derive UFVK + address, broadcast, wait for n-1 peers, verify
  useEffect(() => {
    if (step !== 'fvk-echo' || !deadline || !publicKeyPackage) return;
    let cancelled = false;
    void (async () => {
      try {
        const ufvk = await frostDeriveUfvkInWorker(publicKeyPackage, fvkSkRef.current, true);
        const addr = await frostDeriveAddressFromSkInWorker(publicKeyPackage, fvkSkRef.current, 0);
        if (cancelled) return;

        const relay = relayRef.current;
        if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
        await relay.sendMessage(roomCode.trim(), participantIdRef.current, new TextEncoder().encode(`FVK:${ufvk}`));

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

  // teardown on unmount: abort relay subscription
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      relayRef.current?.disconnect();
    };
  }, []);

  return (
    <SettingsScreen title='join multisig (zigner)' backPath={PopupPath.MULTISIG}>
      {step === 'input' && (
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

      {step === 'waiting-host-r1' && (
        <div className='flex flex-col items-center gap-3'>
          <p className='text-xs text-fg-muted'>waiting for host's round 1 broadcast…</p>
          <span className='i-lucide-loader-2 size-4 animate-spin text-fg-muted' />
          {participantCount > 0 && (
            <p className='text-[10px] text-fg-muted'>
              {participantCount} participant(s) joined
            </p>
          )}
          <span className='text-[10px] text-fg-muted tabular-nums'>{countdown}s</span>
        </div>
      )}

      {step === 'dkg1-show' && (
        <ScreenWithTriggerQr
          headline={`round 1 of 3 (${threshold}-of-${maxSigners})`}
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

// ── helpers (duplicated from zigner-create.tsx; promote to a shared
// module if a third caller appears) ──

interface TriggerProps {
  headline: string;
  body: string;
  triggerJson: string;
  nextLabel: string;
  onNext: () => void;
}

const ScreenWithTriggerQr = ({ headline, body, triggerJson, nextLabel, onNext }: TriggerProps) => (
  <div className='flex flex-col items-center gap-3'>
    <p className='text-xs text-fg-muted'>{headline}</p>
    <p className='text-[10px] text-fg-muted text-center max-w-xs'>{body}</p>
    <QrDisplay data={utf8ToHex(triggerJson)} size={200} />
    <p className='text-[10px] text-fg-muted'>{triggerJson.length} chars</p>
    <button
      className='rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-zigner-gold'
      onClick={onNext}
    >
      {nextLabel}
    </button>
  </div>
);

interface ScanProps {
  title: string;
  onScan: (raw: string) => void;
  onCancel: () => void;
}

// Pass scanner output through verbatim — the per-round handler decides
// whether to treat it as bare hex (r1) or JSON (r2/r3).
const ScanZignerResponse = ({ title, onScan, onCancel }: ScanProps) => (
  <QrScanner title={title} onScan={onScan} onClose={onCancel} inline />
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
