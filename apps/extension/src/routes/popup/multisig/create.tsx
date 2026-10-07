/**
 * create multisig wallet with a zigner: the QR-mediated DKG over frostd,
 * whose share lives on the zigner (`?mode=zigner`, or the active wallet is
 * zigner-imported). A share kept in zafu is made in a group room instead,
 * through its code (people/door, inbox/new-group), so that is where any
 * other visit goes.
 *
 * Wire protocol on the relay: R1:T:N:SK:<sk>:<broadcast>, R2:<pkg>, FVK:<ufvk>.
 */

import { useEffect, useRef, useState } from 'react';
import { RelayKeyExchange } from './relay-key-exchange';
import {
  RelayProbing,
  RendezvousHost,
  useRendezvousAvailable,
  type HostRendezvous,
} from './rendezvous-exchange';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  frostDeriveAddressFromSkInWorker,
  frostSampleFvkSkInWorker,
  frostDeriveUfvkInWorker,
} from '../../../state/keyring/network-worker';
import { selectEffectiveKeyInfo } from '../../../state/keyring';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { requestEgressOptIn } from '../../../net/egress-opt-in';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { useBackNav } from '../../../utils/navigate';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import {
  DEFAULT_RELAY_URL,
  RelayTransportField,
  CancelSessionModal,
  ScreenWithTriggerQr,
  ScanZignerResponse,
  WaitingForRelay,
} from './dkg-helpers';

/* ────────────────────────────────────────────────────────────────────
 * QR-mediated flow: zafu drives the relay; zigner runs FROST math.
 * ──────────────────────────────────────────────────────────────────── */

type ZignerCreateStep =
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

const MultisigCreateZigner = () => {
  const [threshold, setThreshold] = useState(2);
  const [maxSigners, setMaxSigners] = useState(3);
  const [relayUrl, setRelayUrl] = useState('');
  const [step, setStep] = useState<ZignerCreateStep>('config');
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [participantCount, setParticipantCount] = useState(1);
  const [myRelayKey, setMyRelayKey] = useState('');
  const [peerKeys, setPeerKeys] = useState<string[]>([]);
  const [manualKeys, setManualKeys] = useState(false);
  const rdvAvailable = useRendezvousAvailable(relayUrl || DEFAULT_RELAY_URL);
  const rendezvous = rdvAvailable === true && !manualKeys;
  const rdvRef = useRef<HostRendezvous | null>(null);
  const [publicKeyPackage, setPublicKeyPackage] = useState('');
  const [walletId, setWalletId] = useState('');
  const [, setOrchardFvk] = useState('');
  const [address, setAddress] = useState('');
  const [deadline, setDeadline] = useState<number | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const goBack = useBackNav(PopupPath.MULTISIG);

  const participantIdRef = useRef<Uint8Array | null>(null);
  const fvkSkRef = useRef('');
  const peerR1Ref = useRef<string[]>([]);
  const zignerDerivedUfvkRef = useRef('');
  const zignerDerivedAddrRef = useRef('');
  const peerR2Ref = useRef<string[]>([]);
  const peerFvksRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const startDkg = useStore(s => s.frostSession.startDkg);
  const prepareRelayIdentity = useStore(s => s.frostSession.prepareRelayIdentity);
  const resetDkg = useStore(s => s.frostSession.resetDkg);
  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);

  const countdown = useDeadlineCountdown(
    step === 'waiting-room' ||
      step.startsWith('dkg') ||
      step === 'fvk-echo' ||
      step.startsWith('waiting')
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
    relay_url: relayUrl || DEFAULT_RELAY_URL,
    mainnet: true,
  });

  const handleStart = async () => {
    if (!(await requestEgressOptIn('multisig-relay'))) {
      setError('not now - allow the multisig relay to create a room');
      return;
    }
    try {
      const url = relayUrl || DEFAULT_RELAY_URL;
      const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
      setDeadline(sessionDeadline);

      const sk = await frostSampleFvkSkInWorker();
      fvkSkRef.current = sk;

      const code = await startDkg(url, threshold, maxSigners, peerKeys);
      setRoomCode(code);
      // failed announce must not kill the live session - fall back to uuid
      if (rdvRef.current) {
        try {
          await rdvRef.current.announce(code);
        } catch {
          rdvRef.current = null;
        }
      }

      const relay = useStore.getState().frostSession.relay;
      if (!relay) {
        throw new Error('frost relay missing - startDkg did not initialize it');
      }

      const pid = new Uint8Array(32);
      crypto.getRandomValues(pid);
      participantIdRef.current = pid;

      abortRef.current = new AbortController();

      void relay.joinRoom(
        code,
        pid,
        event => {
          if (event.type === 'joined') {
            setParticipantCount(event.participant.participantCount);
          } else if (event.type === 'message') {
            const text = new TextDecoder().decode(event.message.payload);
            const r1 = /^R1:(?:(\d+):(\d+):SK:([0-9a-fA-F]{64}):)?([\s\S]*)$/.exec(text);
            if (r1) {
              peerR1Ref.current.push(r1[4]!);
              return;
            }
            const r2 = /^R2:([\s\S]*)$/.exec(text);
            if (r2) {
              peerR2Ref.current.push(r2[1]!);
              return;
            }
            const fvk = /^FVK:([\s\S]*)$/.exec(text);
            if (fvk) {
              peerFvksRef.current.push(fvk[1]!);
              return;
            }
          } else if (event.type === 'closed') {
            setError(`room closed: ${event.reason}`);
            setStep('error');
          }
        },
        abortRef.current.signal,
      );

      setStep('waiting-room');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const onZignerR1 = async (raw: string) => {
    try {
      if (raw.length === 0) {
        throw new Error('empty r1 ack');
      }
      const broadcastHex =
        /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
          ? raw
          : Array.from(new TextEncoder().encode(raw))
              .map(b => b.toString(16).padStart(2, '0'))
              .join('');
      const relay = useStore.getState().frostSession.relay;
      if (!relay || !participantIdRef.current) {
        throw new Error('relay not initialized');
      }
      const prefixed = `R1:${threshold}:${maxSigners}:SK:${fvkSkRef.current}:${broadcastHex}`;
      await relay.sendMessage(
        roomCode,
        participantIdRef.current,
        new TextEncoder().encode(prefixed),
      );
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
      const relay = useStore.getState().frostSession.relay;
      if (!relay || !participantIdRef.current) {
        throw new Error('relay not initialized');
      }
      for (const pkg of packages) {
        await relay.sendMessage(
          roomCode,
          participantIdRef.current,
          new TextEncoder().encode(`R2:${pkg}`),
        );
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
      if (parsed.orchard_fvk_uview) {
        zignerDerivedUfvkRef.current = parsed.orchard_fvk_uview;
      }
      if (parsed.address) {
        zignerDerivedAddrRef.current = parsed.address;
      }
      setStep('fvk-echo');
    } catch (e) {
      setError(`r3 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  useEffect(() => {
    if (step === 'waiting-room' && participantCount >= maxSigners) {
      setStep('dkg1-show');
    }
  }, [step, participantCount, maxSigners]);

  useEffect(() => {
    if (step !== 'waiting-r1' || !deadline) {
      return;
    }
    let cancelled = false;
    void waitForUntil(() => peerR1Ref.current.length >= maxSigners - 1, deadline)
      .then(() => {
        if (!cancelled) {
          setStep('dkg2-show');
        }
      })
      .catch(e => {
        if (cancelled) {
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      });
    return () => {
      cancelled = true;
    };
  }, [step, maxSigners, deadline]);

  useEffect(() => {
    if (step !== 'waiting-r2' || !deadline) {
      return;
    }
    let cancelled = false;
    void waitForUntil(() => peerR2Ref.current.length >= (maxSigners - 1) ** 2, deadline)
      .then(() => {
        if (!cancelled) {
          setStep('dkg3-show');
        }
      })
      .catch(e => {
        if (cancelled) {
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      });
    return () => {
      cancelled = true;
    };
  }, [step, maxSigners, deadline]);

  useEffect(() => {
    if (step !== 'fvk-echo' || !deadline || !publicKeyPackage) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ufvk =
          zignerDerivedUfvkRef.current ||
          (await frostDeriveUfvkInWorker(publicKeyPackage, fvkSkRef.current, true));
        const addr =
          zignerDerivedAddrRef.current ||
          (await frostDeriveAddressFromSkInWorker(publicKeyPackage, fvkSkRef.current, 0));
        if (cancelled) {
          return;
        }

        const relay = useStore.getState().frostSession.relay;
        if (!relay || !participantIdRef.current) {
          throw new Error('relay not initialized');
        }
        await relay.sendMessage(
          roomCode,
          participantIdRef.current,
          new TextEncoder().encode(`FVK:${ufvk}`),
        );

        await waitForUntil(() => peerFvksRef.current.length >= maxSigners - 1, deadline);
        for (const peerFvk of peerFvksRef.current) {
          if (peerFvk !== ufvk) {
            throw new Error(
              `the co-signers' viewing keys differ (ours ...${ufvk.slice(-8)}, theirs ...${peerFvk.slice(-8)}) · nothing was saved`,
            );
          }
        }

        if (cancelled) {
          return;
        }
        await newFrostMultisigKey({
          label: `${threshold}-of-${maxSigners} multisig`,
          address: addr,
          orchardFvk: ufvk,
          publicKeyPackage,
          threshold,
          maxSigners,
          relayUrl: relayUrl || DEFAULT_RELAY_URL,
          zignerWalletId: walletId,
          custody: 'airgapSigner',
          relayPeerKeys: peerKeys,
          relayCeremonyId: useStore.getState().frostSession.relayCeremonyId ?? undefined,
        });
        resetDkg();

        setOrchardFvk(ufvk);
        setAddress(addr);
        setStep('complete');
      } catch (e) {
        if (cancelled) {
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    step,
    deadline,
    publicKeyPackage,
    maxSigners,
    roomCode,
    threshold,
    relayUrl,
    newFrostMultisigKey,
    walletId,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      resetDkg();
    };
  }, [resetDkg]);

  const sessionLive = step !== 'config' && step !== 'complete' && step !== 'error';

  return (
    <SettingsScreen
      title='create multisig (zigner)'
      backPath={PopupPath.MULTISIG}
      onBack={() => (sessionLive ? setConfirmLeave(true) : goBack())}
    >
      <CancelSessionModal
        open={confirmLeave}
        onStay={() => setConfirmLeave(false)}
        onLeave={goBack}
      />
      {step === 'config' && (
        <div className='flex flex-col gap-4'>
          <StatusSlot tone='warn'>
            cold-multisig: your signing key is generated and stored on zigner only. zafu keeps only
            the public keys needed to watch the wallet.
          </StatusSlot>
          <div className='flex gap-3'>
            <label className='flex-1 text-xs text-fg-muted'>
              signers
              <input
                type='number'
                className='mt-1 w-full border border-border-soft bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
                value={maxSigners}
                onChange={e => setMaxSigners(Number(e.target.value))}
                min={threshold}
                max={255}
              />
            </label>
            <label className='flex-1 text-xs text-fg-muted'>
              approvals needed
              <input
                type='number'
                className='mt-1 w-full border border-border-soft bg-input px-3 py-2.5 text-sm focus:border-primary/50 focus:outline-none'
                value={threshold}
                onChange={e => setThreshold(Number(e.target.value))}
                min={2}
                max={maxSigners}
              />
            </label>
          </div>
          <RelayTransportField value={relayUrl} onChange={setRelayUrl} />
          {rdvAvailable === null ? (
            <RelayProbing />
          ) : rendezvous ? (
            <RendezvousHost
              key={relayUrl || DEFAULT_RELAY_URL}
              relayUrl={relayUrl || DEFAULT_RELAY_URL}
              maxSigners={maxSigners}
              prepare={prepareRelayIdentity}
              onState={s => {
                rdvRef.current = s;
                setPeerKeys(s.peerKeys);
              }}
            />
          ) : (
            <RelayKeyExchange
              maxSigners={maxSigners}
              myKey={myRelayKey}
              onPrepare={prepareRelayIdentity}
              onMyKey={setMyRelayKey}
              onPeerKeys={setPeerKeys}
            />
          )}
          {rdvAvailable === true && (
            <Button
              variant='quiet'
              size='sm'
              className='self-start'
              onClick={() => {
                setManualKeys(m => !m);
                setPeerKeys([]);
                rdvRef.current = null;
              }}
            >
              {manualKeys ? 'use a room code instead' : 'advanced: manual key exchange'}
            </Button>
          )}
          <Button
            variant='primary'
            className='w-full'
            disabled={peerKeys.length !== maxSigners - 1}
            onClick={() => void handleStart()}
          >
            {peerKeys.length === maxSigners - 1
              ? 'create'
              : `waiting for ${maxSigners - 1 - peerKeys.length} more relay key(s)`}
          </Button>
        </div>
      )}

      {step === 'waiting-room' && (
        <div className='flex flex-col items-center gap-4'>
          <p className='text-xs text-fg-muted'>
            {rdvRef.current
              ? 'your co-signers are picked up automatically - they already have the room code'
              : 'share this session id with your co-signers'}
          </p>
          <div className='break-all px-4 font-mono text-xs'>{rdvRef.current?.code ?? roomCode}</div>
          <div className='flex items-center gap-2 bg-elev-2 px-3 py-1.5'>
            <span className='i-ph-users size-3.5 text-fg-muted' />
            <span className='text-xs'>
              <span className='text-fg'>{participantCount}</span>
              <span className='text-fg-muted'> / {maxSigners} joined</span>
            </span>
          </div>
          <span className='text-label text-fg-muted tabular-nums'>{countdown}s</span>
        </div>
      )}

      {step === 'dkg1-show' && (
        <ScreenWithTriggerQr
          headline='step 1 of 3'
          body='scan with zigner to start key setup.'
          triggerJson={dkg1Trigger}
          nextLabel='scan zigner response'
          onNext={() => setStep('dkg1-scan')}
        />
      )}

      {step === 'dkg1-scan' && (
        <ScanZignerResponse
          title='scan the response QR from zigner'
          onScan={raw => void onZignerR1(raw)}
          onCancel={() => setStep('dkg1-show')}
        />
      )}

      {step === 'waiting-r1' && (
        <WaitingForRelay
          headline='step 1 sent'
          body='waiting for the other signers...'
          countdown={countdown}
        />
      )}

      {step === 'dkg2-show' && (
        <ScreenWithTriggerQr
          headline='step 2 of 3'
          body='scan with zigner to exchange keys.'
          triggerJson={dkg2Trigger}
          nextLabel='scan zigner response'
          onNext={() => setStep('dkg2-scan')}
        />
      )}

      {step === 'dkg2-scan' && (
        <ScanZignerResponse
          title='scan the response QR from zigner'
          onScan={raw => void onZignerR2(raw)}
          onCancel={() => setStep('dkg2-show')}
        />
      )}

      {step === 'waiting-r2' && (
        <WaitingForRelay
          headline='step 2 sent'
          body='waiting for the other signers...'
          countdown={countdown}
        />
      )}

      {step === 'dkg3-show' && (
        <ScreenWithTriggerQr
          headline='step 3 of 3'
          body='scan with zigner to finish - your key is stored on the device.'
          triggerJson={dkg3Trigger}
          nextLabel='scan zigner confirmation'
          onNext={() => setStep('dkg3-scan')}
        />
      )}

      {step === 'dkg3-scan' && (
        <ScanZignerResponse
          title='scan the confirmation QR from zigner'
          onScan={onZignerR3}
          onCancel={() => setStep('dkg3-show')}
        />
      )}

      {step === 'fvk-echo' && (
        <div className='flex flex-col items-center gap-3'>
          <p className='text-xs text-fg-muted'>double-checking everyone sees the same wallet...</p>
          <span className='i-ph-circle-notch size-4 animate-spin text-fg-muted' />
          <p className='text-label text-fg-muted tabular-nums'>{countdown}s</p>
        </div>
      )}

      {step === 'complete' && (
        <div className='flex flex-col gap-3'>
          <div className='border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            multisig wallet saved - signing key lives on zigner only
          </div>
          <div className='border border-border-soft bg-elev-1 p-3'>
            <p className='text-label text-fg-muted'>address</p>
            <p className='mt-1 break-all font-mono text-xs'>{address}</p>
          </div>
          <p className='text-label text-fg-muted'>
            zigner wallet_id: <span className='font-mono'>{walletId}</span>
          </p>
          <Button variant='primary' className='w-full' onClick={goBack}>
            done
          </Button>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <StatusSlot tone='danger'>{error}</StatusSlot>
          <Button
            variant='secondary'
            className='w-full'
            onClick={() => {
              setStep('config');
              setError('');
              resetDkg();
            }}
          >
            try again
          </Button>
        </div>
      )}
    </SettingsScreen>
  );
};

/* ────────────────────────────────────────────────────────────────────
 * Unified entry: picks zafu-hot or zigner-QR based on URL or wallet.
 * ──────────────────────────────────────────────────────────────────── */

export const MultisigCreate = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const [params] = useSearchParams();
  const isZignerMode = params.get('mode') === 'zigner' || selectedKeyInfo?.type === 'zigner-zafu';

  // a hot share is made in a group room now, through its code (people/door)
  return isZignerMode ? (
    <MultisigCreateZigner />
  ) : (
    <Navigate to={`${PopupPath.INBOX_NEW_GROUP}?wallet=1`} replace />
  );
};
