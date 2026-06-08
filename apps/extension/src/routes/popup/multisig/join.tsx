/**
 * join multisig wallet - unified entry for both flows.
 *
 * Two implementations live here. The exported `MultisigJoin` dispatches:
 *   - `?mode=zigner` URL param, OR
 *   - active wallet is zigner-imported (`type === 'zigner-zafu'`)
 *   →  MultisigJoinZigner (QR-mediated; share lives on zigner)
 *
 *   - otherwise
 *   →  MultisigJoinZafu (hot DKG; share lives in zafu)
 *
 * Sessions tab passes `?mode=zigner` when the airgap toggle is on, so the
 * route surface stays at one URL per verb: /multisig/join.
 *
 * Each sub-component bootstraps T/N/sk by parsing the host's R1 broadcast
 * off the relay, then runs the remaining 3-round DKG and FVK echo.
 */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostDeriveAddressFromSkInWorker,
  frostDeriveUfvkInWorker,
} from '../../../state/keyring/network-worker';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { hexToBytes } from '@repo/wallet/networks';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';

/* ────────────────────────────────────────────────────────────────────
 * Zafu-hot flow: FROST math runs in zafu's worker; share stored locally.
 * ──────────────────────────────────────────────────────────────────── */

type JoinStep = 'input' | 'joining' | 'dkg' | 'fvk-echo' | 'complete' | 'error';

const MultisigJoinZafu = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<JoinStep>('input');
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [progress, setProgress] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [thresholdInfo, setThresholdInfo] = useState('');
  const [participantCount, setParticipantCount] = useState(0);
  const [maxSigners, setMaxSignersDisplay] = useState(0);
  const [deadline, setDeadline] = useState<number | null>(null);
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const countdown = useDeadlineCountdown(
    step === 'joining' || step === 'dkg' || step === 'fvk-echo' ? deadline : null,
  );

  const handleJoin = async () => {
    if (!roomCode.trim()) return;

    const abortController = new AbortController();
    const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
    setDeadline(sessionDeadline);
    try {
      const url = relayUrl || 'wss://zrelay.rotko.net';
      setStep('joining');

      const relay = new FrostRelayClient(url);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);

      let threshold = 0;
      let maxSignersLocal = 0;
      let fvkSk = '';
      const peerBroadcasts: string[] = [];
      const peerRound2: string[] = [];
      const peerFvks: string[] = [];

      setStep('dkg');
      setProgress('waiting for coordinator...');

      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type === 'joined') {
          setParticipantCount(event.participant.participantCount);
        } else if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          const r1 = text.match(/^R1:(?:(\d+):(\d+):SK:([0-9a-fA-F]{64}):)?([\s\S]*)$/);
          if (r1) {
            if (r1[1] && r1[2] && r1[3]) {
              threshold = Number(r1[1]);
              maxSignersLocal = Number(r1[2]);
              fvkSk = r1[3];
              setThresholdInfo(`${threshold}-of-${maxSignersLocal}`);
              setMaxSignersDisplay(maxSignersLocal);
            }
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
          console.warn('[multisig-join] unknown frost message, dropping:', text.slice(0, 32));
        } else if (event.type === 'closed') {
          setError(`room closed: ${event.reason}`);
          setStep('error');
        }
      }, abortController.signal);

      await waitForUntil(
        () => threshold > 0 && maxSignersLocal > 0 && fvkSk.length === 64,
        sessionDeadline,
      );
      setProgress('round 1: generating commitment...');

      const round1 = await frostDkgPart1InWorker(maxSignersLocal, threshold);
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

      const expectedR2 = (maxSignersLocal - 1) ** 2;
      setProgress(`round 2: waiting for ${expectedR2} peer package(s)...`);
      await waitForUntil(() => peerRound2.length >= expectedR2, sessionDeadline);

      setProgress('round 3: finalizing...');
      const round3 = await frostDkgPart3InWorker(
        round2.secret,
        peerBroadcasts,
        peerRound2,
      );

      const addrRaw = await frostDeriveAddressFromSkInWorker(round3.public_key_package, fvkSk, 0);
      const addr = encodeOrchardUnifiedAddress(hexToBytes(addrRaw), true);
      setAddress(addr);

      const orchardFvk = await frostDeriveUfvkInWorker(round3.public_key_package, fvkSk, true);

      setStep('fvk-echo');
      setProgress('verifying viewing key agreement...');
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(`FVK:${orchardFvk}`));
      await waitForUntil(() => peerFvks.length >= maxSignersLocal - 1, sessionDeadline);
      for (const peerFvk of peerFvks) {
        if (peerFvk !== orchardFvk) {
          throw new Error(
            `FVK mismatch: peer saw a different viewing key - ` +
              `ours ends ...${orchardFvk.slice(-8)}, theirs ends ...${peerFvk.slice(-8)}`,
          );
        }
      }

      await newFrostMultisigKey({
        label: `${threshold}-of-${maxSignersLocal} multisig`,
        address: addr,
        orchardFvk,
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
              placeholder='wss://zrelay.rotko.net'
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

      {(step === 'joining' || step === 'dkg' || step === 'fvk-echo') && (
        <div className='flex flex-col items-center gap-4'>
          {thresholdInfo && (
            <span className='rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-zigner-gold'>
              {thresholdInfo}
            </span>
          )}

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

/* ────────────────────────────────────────────────────────────────────
 * QR-mediated flow: zafu drives the relay; zigner runs FROST math.
 * Mirrors the create-zigner flow but bootstraps T/N/sk from host's R1.
 * ──────────────────────────────────────────────────────────────────── */

type ZignerJoinStep =
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

const MultisigJoinZigner = () => {
  const [relayUrl, setRelayUrl] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<ZignerJoinStep>('input');
  const [error, setError] = useState('');
  const [participantCount, setParticipantCount] = useState(0);

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
  const zignerDerivedUfvkRef = useRef('');
  const zignerDerivedAddrRef = useRef('');
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
    sk: fvkSkRef.current,
    relay_url: relayUrl || 'wss://zrelay.rotko.net',
    mainnet: true,
  });

  const handleJoin = async () => {
    if (!roomCode.trim()) return;
    try {
      const url = relayUrl || 'wss://zrelay.rotko.net';
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

  const onZignerR3 = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as {
        frost?: string;
        public_key_package?: string;
        wallet_id?: string;
        orchard_fvk_uview?: string;
        address?: string;
        relay_url?: string;
      };
      if (parsed.frost !== 'r3' || !parsed.public_key_package || !parsed.wallet_id) {
        throw new Error('not an r3 ack');
      }
      setPublicKeyPackage(parsed.public_key_package);
      setWalletId(parsed.wallet_id);
      if (parsed.orchard_fvk_uview) zignerDerivedUfvkRef.current = parsed.orchard_fvk_uview;
      if (parsed.address) zignerDerivedAddrRef.current = parsed.address;
      setStep('fvk-echo');
    } catch (e) {
      setError(`r3 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

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

  useEffect(() => {
    if (step !== 'fvk-echo' || !deadline || !publicKeyPackage) return;
    let cancelled = false;
    void (async () => {
      try {
        const ufvk = zignerDerivedUfvkRef.current
          || await frostDeriveUfvkInWorker(publicKeyPackage, fvkSkRef.current, true);
        const addr = zignerDerivedAddrRef.current
          || await frostDeriveAddressFromSkInWorker(publicKeyPackage, fvkSkRef.current, 0);
        if (cancelled) return;

        const relay = relayRef.current;
        if (!relay || !participantIdRef.current) throw new Error('relay not initialized');
        await relay.sendMessage(roomCode.trim(), participantIdRef.current, new TextEncoder().encode(`FVK:${ufvk}`));

        await waitForUntil(() => peerFvksRef.current.length >= maxSigners - 1, deadline);
        for (const peerFvk of peerFvksRef.current) {
          if (peerFvk !== ufvk) {
            throw new Error(
              `FVK mismatch: ours ...${ufvk.slice(-8)}, theirs ...${peerFvk.slice(-8)}`,
            );
          }
        }

        if (cancelled) return;
        await newFrostMultisigKey({
          label: `${threshold}-of-${maxSigners} multisig`,
          address: addr,
          orchardFvk: ufvk,
          publicKeyPackage,
          threshold,
          maxSigners,
          relayUrl: relayUrl || 'wss://zrelay.rotko.net',
          custody: 'airgapSigner',
          zignerWalletId: walletId,
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
  }, [step, deadline, publicKeyPackage, maxSigners, roomCode, threshold, relayUrl, newFrostMultisigKey, walletId]);

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
              placeholder='wss://zrelay.rotko.net'
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
          <p className='text-xs text-fg-muted'>waiting for host's round 1 broadcast...</p>
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
          body={`waiting for ${maxSigners - 1} peer R1 broadcast(s)...`}
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
          body={`waiting for ${(maxSigners - 1) ** 2} peer R2 package(s)...`}
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
          <p className='text-xs text-fg-muted'>verifying viewing key agreement...</p>
          <span className='i-lucide-loader-2 size-4 animate-spin text-fg-muted' />
          <p className='text-[10px] text-fg-muted tabular-nums'>{countdown}s</p>
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            multisig wallet saved - share lives on zigner only
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

/* ────────────────────────────────────────────────────────────────────
 * Small inline helpers used by the QR-mediated flow.
 * ──────────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────────────
 * Unified entry: picks zafu-hot or zigner-QR based on URL or wallet.
 * ──────────────────────────────────────────────────────────────────── */

export const MultisigJoin = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const [params] = useSearchParams();
  const isZignerMode = params.get('mode') === 'zigner'
    || selectedKeyInfo?.type === 'zigner-zafu';

  return isZignerMode ? <MultisigJoinZigner /> : <MultisigJoinZafu />;
};
