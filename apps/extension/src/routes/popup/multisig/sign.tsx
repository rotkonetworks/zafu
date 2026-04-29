/**
 * co-sign multisig transaction
 *
 *   input   → user pastes room code
 *   joining → joins relay, waits for coordinator's SIGN: prefix
 *   review  → shows tx summary, user approves/rejects
 *   signing → password gate, FROST round 1 + round 2
 *   complete | error
 */

import { useRef, useState } from 'react';
import { useStore } from '../../../state';
import { selectActiveZcashWallet } from '../../../state/wallets';
import {
  frostSignRound1InWorker,
  frostSpendSignInWorker,
} from '../../../state/keyring/network-worker';
import { FrostRelayClient } from '../../../state/keyring/frost-relay-client';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { usePasswordGate } from '../../../hooks/password-gate';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { FrostAirgapJoinerSignFlow } from '../../popup/send/frost-multisig';

type Step = 'input' | 'joining' | 'review' | 'signing' | 'complete' | 'error';

export const MultisigSign = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amountZat, setAmountZat] = useState('');
  const [feeZat, setFeeZat] = useState('');
  const [deadline, setDeadline] = useState<number | null>(null);

  const activeWallet = useStore(selectActiveZcashWallet);
  const ms = activeWallet?.multisig;

  const { requestAuth, PasswordModal } = usePasswordGate();

  // session state preserved across the join → review → sign transitions
  const relayRef = useRef<FrostRelayClient | null>(null);
  const participantIdRef = useRef<Uint8Array | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sighashRef = useRef('');
  const alphasRef = useRef<string[]>([]);
  const peerCommitmentsRef = useRef<string[] | null>(null);

  const countdown = useDeadlineCountdown(
    step === 'joining' || step === 'review' || step === 'signing' ? deadline : null,
  );

  const teardown = () => {
    abortRef.current?.abort();
    relayRef.current = null;
    participantIdRef.current = null;
    abortRef.current = null;
    sighashRef.current = '';
    alphasRef.current = [];
    peerCommitmentsRef.current = null;
  };

  const handleJoin = async () => {
    if (!roomCode.trim() || !ms) return;

    const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
    setDeadline(sessionDeadline);
    setStep('joining');
    setProgress('connecting to signing session...');

    try {
      const relayUrl = (typeof ms.relayUrl === 'string' ? ms.relayUrl : '') || 'https://poker.zk.bot';
      const relay = new FrostRelayClient(relayUrl);
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);
      const abortController = new AbortController();
      relayRef.current = relay;
      participantIdRef.current = participantId;
      abortRef.current = abortController;

      void relay.joinRoom(roomCode.trim(), participantId, (event) => {
        if (event.type !== 'message') return;
        const text = new TextDecoder().decode(event.message.payload);
        // SIGN:<sighash>:<alphas>:<recipient>:<amountZat>:<feeZat>
        const signMatch = text.match(/^SIGN:([0-9a-fA-F]+):([^:]+):([^:]+):(\d+):(\d+)$/);
        if (signMatch) {
          sighashRef.current = signMatch[1]!;
          alphasRef.current = signMatch[2]!.split(',');
          setRecipient(signMatch[3]!);
          setAmountZat(signMatch[4]!);
          setFeeZat(signMatch[5]!);
          return;
        }
        const commitMatch = text.match(/^C:([\s\S]*)$/);
        if (commitMatch && !peerCommitmentsRef.current) {
          peerCommitmentsRef.current = commitMatch[1]!.split('|');
        }
      }, abortController.signal);

      setProgress('waiting for transaction data...');
      await waitForUntil(() => sighashRef.current.length > 0, sessionDeadline);
      setStep('review');
    } catch (e) {
      teardown();
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const handleApprove = async () => {
    if (!ms || !relayRef.current || !participantIdRef.current) return;

    const authorized = await requestAuth();
    if (!authorized) return;

    setStep('signing');
    setProgress('decrypting keys...');

    const relay = relayRef.current;
    const participantId = participantIdRef.current;
    const sessionDeadline = deadline ?? Date.now() + FROST_SESSION_TIMEOUT_MS;

    try {
      const secrets = await useStore.getState().keyRing.getMultisigSecrets(activeWallet!.vaultId);
      if (!secrets) throw new Error('failed to decrypt multisig keys');

      const sighash = sighashRef.current;
      const alphas = alphasRef.current;
      const numActions = alphas.length;

      setProgress(`round 1: generating ${numActions} commitment(s)...`);
      const round1s: { nonces: string; commitments: string }[] = [];
      for (let i = 0; i < numActions; i++) {
        round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
      }

      const ourCommitments = round1s.map(r => r.commitments).join('|');
      await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(`C:${ourCommitments}`));

      setProgress('round 1: waiting for coordinator...');
      await waitForUntil(() => peerCommitmentsRef.current !== null, sessionDeadline);

      const peerCommits = peerCommitmentsRef.current!;
      if (peerCommits.length < numActions) {
        throw new Error(`coordinator sent ${peerCommits.length} commitments but ${numActions} actions needed`);
      }

      for (let i = 0; i < numActions; i++) {
        setProgress(`round 2: signing action ${i + 1}/${numActions}...`);
        const allCommitments = [round1s[i]!.commitments, peerCommits[i]!];
        const share = await frostSpendSignInWorker(
          secrets.keyPackage, round1s[i]!.nonces, sighash, alphas[i]!, allCommitments,
        );
        await relay.sendMessage(roomCode.trim(), participantId, new TextEncoder().encode(`S:${i}:${share}`));
      }

      setStep('complete');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      teardown();
    }
  };

  const handleReject = () => {
    teardown();
    setStep('input');
    setRoomCode('');
    setRecipient('');
    setAmountZat('');
    setFeeZat('');
  };

  const formatZec = (zat: string): string => {
    if (!zat) return '0';
    return (Number(zat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  };

  if (!ms) {
    return (
      <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
        <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
          no active multisig wallet - select a multisig wallet first
        </div>
      </SettingsScreen>
    );
  }

  // airgapSigner wallets: share lives on zigner. QR-mediated co-sign flow.
  if (ms.custody === 'airgapSigner') {
    return (
      <AirgapJoinerWrapper
        ms={ms}
        walletLabel={activeWallet!.label}
        walletAddress={activeWallet!.address}
      />
    );
  }

  return (
    <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
      {PasswordModal}
      <div className='mb-4 rounded-lg border border-border-soft bg-elev-1 p-3'>
        <p className='text-[10px] text-fg-muted'>signing as</p>
        <p className='mt-0.5 text-sm font-medium truncate'>{activeWallet!.label}</p>
        <p className='text-[10px] font-mono text-fg-muted truncate'>
          {activeWallet!.address.slice(0, 16)}...{activeWallet!.address.slice(-8)}
        </p>
        <span className='mt-1 inline-block rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-zigner-gold'>
          {ms.threshold}/{ms.maxSigners}
        </span>
      </div>

      {step === 'input' && (
        <div className='flex flex-col gap-4'>
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

      {step === 'joining' && (
        <div className='flex items-center gap-2 text-xs text-fg-muted'>
          <span className='i-lucide-loader-2 size-3.5 animate-spin' />
          {progress}
          <span className='tabular-nums text-fg-dim'>{countdown}s</span>
        </div>
      )}

      {step === 'review' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3'>
            <p className='text-[10px] uppercase tracking-wider text-yellow-400'>review transaction</p>
          </div>

          <div className='rounded-lg border border-border-soft bg-elev-1 p-3 flex flex-col gap-2.5'>
            <div>
              <p className='text-[10px] uppercase tracking-wider text-fg-muted'>from</p>
              <p className='mt-0.5 text-xs font-medium'>{activeWallet!.label}</p>
              <p className='mt-0.5 break-all font-mono text-[10px] text-fg-muted'>
                {activeWallet!.address}
              </p>
            </div>
            <div className='border-t border-border-soft' />
            <div>
              <p className='text-[10px] uppercase tracking-wider text-fg-muted'>to</p>
              <p className='mt-0.5 break-all font-mono text-[10px]'>{recipient}</p>
            </div>
            <div className='border-t border-border-soft' />
            <div className='flex items-baseline justify-between'>
              <span className='text-[10px] uppercase tracking-wider text-fg-muted'>amount</span>
              <span className='tabular text-sm font-medium'>{formatZec(amountZat)} ZEC</span>
            </div>
            <div className='flex items-baseline justify-between'>
              <span className='text-[10px] uppercase tracking-wider text-fg-muted'>fee</span>
              <span className='tabular text-xs text-fg-muted'>{formatZec(feeZat)} ZEC</span>
            </div>
          </div>

          <p className='text-[10px] text-fg-muted'>
            approving signs with this wallet's share. coordinator aggregates and broadcasts.
          </p>

          <div className='grid grid-cols-2 gap-2'>
            <button
              onClick={handleReject}
              className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
            >
              reject
            </button>
            <button
              onClick={() => void handleApprove()}
              className='rounded-lg border border-primary/40 bg-primary/5 py-2 text-xs text-zigner-gold hover:bg-primary/10 transition-colors'
            >
              approve &amp; sign
            </button>
          </div>
        </div>
      )}

      {step === 'signing' && (
        <div className='flex flex-col items-center gap-4'>
          {recipient && (
            <div className='w-full rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3'>
              <p className='text-[10px] uppercase tracking-wider text-yellow-400'>signing</p>
              <p className='mt-0.5 text-sm font-medium text-yellow-300'>
                {formatZec(amountZat)} ZEC →{' '}
                <span className='font-mono text-[10px]'>{recipient.slice(0, 16)}…{recipient.slice(-6)}</span>
              </p>
            </div>
          )}
          <div className='flex items-center gap-2 text-xs text-fg-muted'>
            <span className='i-lucide-loader-2 size-3.5 animate-spin' />
            {progress}
            <span className='tabular-nums text-fg-dim'>{countdown}s</span>
          </div>
        </div>
      )}

      {step === 'complete' && (
        <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
          signing shares sent - coordinator will broadcast the transaction
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
            {error}
          </div>
          <button
            onClick={() => { teardown(); setStep('input'); setError(''); }}
            className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
          >
            try again
          </button>
        </div>
      )}
    </SettingsScreen>
  );
};

type WrapperPhase = 'input' | 'active' | 'done';

// airgap joiner: paste room code → delegate to FrostAirgapJoinerSignFlow,
// then land on a green "shares sent" confirmation (matches mnemonic joiner).
const AirgapJoinerWrapper = ({
  ms, walletLabel, walletAddress,
}: {
  ms: { publicKeyPackage: string; threshold: number; maxSigners: number; relayUrl?: string };
  walletLabel: string;
  walletAddress: string;
}) => {
  const [room, setRoom] = useState('');
  const [phase, setPhase] = useState<WrapperPhase>('input');
  const [error, setError] = useState('');

  const reset = () => { setPhase('input'); setRoom(''); setError(''); };

  const WalletCard = () => (
    <div className='mb-4 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <p className='text-[10px] text-fg-muted'>signing as</p>
      <p className='mt-0.5 text-sm font-medium truncate'>{walletLabel}</p>
      <p className='text-[10px] font-mono text-fg-muted truncate'>
        {walletAddress.slice(0, 16)}...{walletAddress.slice(-8)}
      </p>
      <span className='mt-1 inline-block rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-zigner-gold'>
        {ms.threshold}/{ms.maxSigners} · airgap
      </span>
    </div>
  );

  if (phase === 'active') {
    if (error) {
      return (
        <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
          <div className='flex flex-col gap-3'>
            <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>{error}</div>
            <button
              onClick={reset}
              className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
            >
              try again
            </button>
          </div>
        </SettingsScreen>
      );
    }
    return (
      <FrostAirgapJoinerSignFlow
        ms={ms}
        roomCode={room}
        walletLabel={walletLabel}
        walletAddress={walletAddress}
        onComplete={() => setPhase('done')}
        onCancel={reset}
        onError={setError}
      />
    );
  }

  if (phase === 'done') {
    return (
      <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
        <WalletCard />
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
            signing shares sent — coordinator will broadcast the transaction
          </div>
          <button
            onClick={reset}
            className='rounded-lg border border-border-soft py-2 text-xs hover:bg-elev-1 transition-colors'
          >
            co-sign another
          </button>
        </div>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
      <WalletCard />
      <div className='flex flex-col gap-4'>
        <label className='text-xs text-fg-muted'>
          room code
          <input
            className='mt-1 w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 font-mono text-sm focus:border-primary/50 focus:outline-none'
            value={room}
            onChange={e => setRoom(e.target.value)}
            placeholder='acid-blue-cave'
            autoFocus
          />
        </label>
        <button
          className='w-full rounded-lg border border-primary/40 bg-primary/5 py-2.5 text-sm text-zigner-gold hover:bg-primary/10 transition-colors disabled:opacity-50'
          onClick={() => setPhase('active')}
          disabled={!room.trim()}
        >
          join
        </button>
      </div>
    </SettingsScreen>
  );
};
