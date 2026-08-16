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
  frostInspectPcztOutputsInWorker,
  type FrostParsedTx,
} from '../../../state/keyring/network-worker';
import {
  computeVerdict,
  assessClaimedFee,
  verdictAllowsSigning,
  type Verdict,
} from '../send/frost-multisig/multisig-verifier';
import { FrostdRelayClient } from '../../../state/keyring/frostd-relay-client';
import {
  buildRelayIdentity,
  getOrCreateRelayIdentity,
} from '../../../state/keyring/relay-identity';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../../state/frost-session';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { usePasswordGate } from '../../../hooks/password-gate';
import { SettingsScreen } from '../settings/settings-screen';
import { PopupPath } from '../paths';
import { FrostAirgapJoinerSignFlow } from '../send/frost-multisig';
import { Sensitive } from '../../../components/sensitive';
import { DEFAULT_RELAY_URL } from './dkg-helpers';

type Step = 'input' | 'joining' | 'review' | 'signing' | 'complete' | 'error';

/**
 * The exact signing request this screen latched onto. Immutable once set: the
 * relay handler accepts the FIRST `SIGN:` of a session and treats any later one
 * as a takeover attempt. Everything downstream (verdict, display, the share we
 * actually release) is derived from this one object, so what the user reviewed
 * and what gets signed cannot drift apart.
 */
interface SignRequest {
  sighash: string;
  alphas: string[];
  recipient: string;
  amountZat: string;
  feeZat: string;
  pcztHex?: string;
}

export const MultisigSign = () => {
  const [roomCode, setRoomCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amountZat, setAmountZat] = useState('');
  const [feeZat, setFeeZat] = useState('');
  const [deadline, setDeadline] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<Verdict>({ kind: 'pending' });
  const [parsed, setParsed] = useState<FrostParsedTx | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const activeWallet = useStore(selectActiveZcashWallet);
  const ms = activeWallet?.multisig;

  const { requestAuth, PasswordModal } = usePasswordGate();

  // session state preserved across the join → review → sign transitions
  const relayRef = useRef<FrostdRelayClient | null>(null);
  const participantIdRef = useRef<Uint8Array | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // the latched request — set exactly once per session, never mutated after.
  const txRef = useRef<SignRequest | null>(null);
  // set if a second, different SIGN: lands after we latched. Poisons the
  // session: the user reviewed request #1, so request #2 has no consent.
  const supersededRef = useRef(false);
  // raw "c0|c1|..." per peer; per-action split happens after numActions known.
  const peerCommitsRawRef = useRef<string[]>([]);

  const countdown = useDeadlineCountdown(
    step === 'joining' || step === 'review' || step === 'signing' ? deadline : null,
  );

  const teardown = () => {
    abortRef.current?.abort();
    relayRef.current = null;
    participantIdRef.current = null;
    abortRef.current = null;
    txRef.current = null;
    supersededRef.current = false;
    peerCommitsRawRef.current = [];
  };

  const handleJoin = async () => {
    if (!roomCode.trim() || !ms) {
      return;
    }

    const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
    setDeadline(sessionDeadline);
    setStep('joining');
    setProgress('connecting to signing session...');

    try {
      const relayUrl = (typeof ms.relayUrl === 'string' ? ms.relayUrl : '') || DEFAULT_RELAY_URL;
      // ceremony id is the group's public key package: stable for this
      // group, and unrelated to any other, so a relay operator cannot link
      // a user's groups to one another
      const peerKeys = (ms as { relayPeerKeys?: string[] }).relayPeerKeys ?? [];
      if (peerKeys.length === 0) {
        throw new Error(
          'this wallet has no co-signer relay keys on file - exchange them before signing',
        );
      }
      const stored = await getOrCreateRelayIdentity(String(ms.publicKeyPackage));
      const relay = new FrostdRelayClient(relayUrl, await buildRelayIdentity(stored, peerKeys));
      const participantId = new Uint8Array(32);
      crypto.getRandomValues(participantId);
      const abortController = new AbortController();
      relayRef.current = relay;
      participantIdRef.current = participantId;
      abortRef.current = abortController;

      // the relay redelivers buffered room history, so a byte-identical repeat
      // of the SIGN: we already latched is benign; only a *different* one is a
      // takeover.
      let lastSignText = '';

      void relay.joinRoom(
        roomCode.trim(),
        participantId,
        event => {
          if (event.type !== 'message') {
            return;
          }
          const text = new TextDecoder().decode(event.message.payload);
          // SIGN:<sighash>:<alphas>:<recipient>:<amountZat>:<feeZat>[:<pcztHex>]
          const signMatch =
            /^SIGN:([0-9a-fA-F]+):([^:]+):([^:]+):(\d+):(\d+)(?::([0-9a-fA-F]+))?$/.exec(text);
          if (signMatch) {
            const req: SignRequest = {
              sighash: signMatch[1]!,
              alphas: signMatch[2]!.split(','),
              recipient: signMatch[3]!,
              amountZat: signMatch[4]!,
              feeZat: signMatch[5]!,
              pcztHex: signMatch[6],
            };

            // Latch. Anyone who can guess the room code can post here, so a
            // second SIGN: is not a "retry" — it is an attempt to swap the tx
            // out from under a review the user has already started (classic
            // case: land it while the password modal is up). Poison the
            // session instead; the user can re-join for a fresh one.
            if (txRef.current) {
              if (text !== lastSignText) {
                supersededRef.current = true;
                setVerdict({
                  kind: 'refuse',
                  reasons: [
                    'the host published a SECOND, different transaction after you began reviewing this one',
                    'this session is void — reject and re-join if you still intend to sign',
                  ],
                });
              }
              return;
            }
            txRef.current = req;
            lastSignText = text;

            setRecipient(req.recipient);
            setAmountZat(req.amountZat);
            setFeeZat(req.feeZat);

            // Verifier: derive output truth from the PCZT (recompute sighash +
            // OVK-decrypt outputs). Anything that cannot be verified refuses —
            // there is no "show it anyway and leave approve live" path, because
            // the host chooses whether we can verify. FROST multisig wallets
            // store the `uview1…` string in `orchardFvk` (DKG flows save it
            // there); single-key wallets store it in `ufvk`.
            const ufvkForVerify = activeWallet?.multisig
              ? activeWallet.orchardFvk
              : activeWallet?.ufvk;
            const fee = assessClaimedFee(req.feeZat, req.amountZat);
            if (!req.pcztHex) {
              setVerdict({
                kind: 'refuse',
                reasons: [
                  'host did not publish the PCZT bytes — everything shown here would be host-authored text bound to nothing',
                  'refusing to release a share against an unverifiable request',
                ],
              });
            } else if (!ufvkForVerify) {
              setVerdict({
                kind: 'refuse',
                reasons: [
                  'this wallet has no viewing key on file, so the PCZT cannot be decoded',
                  'refusing to release a share against an unverifiable request',
                ],
              });
            } else if (!fee.ok) {
              setVerdict({ kind: 'refuse', reasons: [fee.reason] });
            } else {
              const ufvk = ufvkForVerify;
              const isMain = activeWallet.mainnet;
              const pcztHex = req.pcztHex;
              void (async () => {
                try {
                  const p = await frostInspectPcztOutputsInWorker(pcztHex, ufvk);
                  setParsed(p);
                  setVerdict(
                    computeVerdict({
                      parsed: p,
                      claimedRecipient: req.recipient,
                      claimedAmountZat: req.amountZat,
                      claimedSighashHex: req.sighash,
                      mainnet: isMain,
                    }),
                  );
                } catch (err) {
                  setVerdict({
                    kind: 'refuse',
                    reasons: [
                      `could not parse the published PCZT: ${err instanceof Error ? err.message : 'parse failed'}`,
                      'refusing to release a share against an unverifiable request',
                    ],
                  });
                }
              })();
            }
            return;
          }
          // collect ALL peer C: bundles - t≥3 needs threshold-1 of them, not just 1.
          const commitMatch = /^C:([\s\S]*)$/.exec(text);
          if (commitMatch) {
            peerCommitsRawRef.current.push(commitMatch[1]!);
          }
        },
        abortController.signal,
      );

      setProgress('waiting for transaction data...');
      await waitForUntil(() => txRef.current !== null, sessionDeadline);
      setStep('review');
    } catch (e) {
      teardown();
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const handleApprove = async () => {
    if (!ms || !relayRef.current || !participantIdRef.current) {
      return;
    }

    // ── snapshot what the user is consenting to, BEFORE any await ──
    // `approved` is the request the verdict on screen was computed from. From
    // here on nothing reads txRef for signing purposes; only `approved` is
    // signed. `verdict`/`acknowledged` are this render's values — i.e. exactly
    // what was displayed when the button was clicked.
    const approved = txRef.current;
    if (!approved) {
      return;
    }
    const reviewedVerdict = verdict;
    if (!verdictAllowsSigning(reviewedVerdict, acknowledged)) {
      return;
    }

    // The password modal is open for seconds. That window is the whole attack:
    // a second SIGN: draining the vault lands while the user is typing. The
    // handler poisons the session in that case; re-check after the await.
    const authorized = await requestAuth();
    if (!authorized) {
      return;
    }
    if (supersededRef.current || txRef.current !== approved) {
      teardown();
      setError(
        'the signing request changed while you were authenticating — nothing was signed. re-join to review the new request.',
      );
      setStep('error');
      return;
    }

    setStep('signing');
    setProgress('decrypting keys...');

    const relay = relayRef.current;
    const participantId = participantIdRef.current;
    const sessionDeadline = deadline ?? Date.now() + FROST_SESSION_TIMEOUT_MS;

    try {
      const secrets = await useStore.getState().keyRing.getMultisigSecrets(activeWallet.vaultId);
      if (!secrets) {
        throw new Error('failed to decrypt multisig keys');
      }

      // sign the snapshot, never the live ref.
      const { sighash, alphas } = approved;
      const numActions = alphas.length;

      setProgress(`round 1: generating ${numActions} commitment(s)...`);
      const round1s: { nonces: string; commitments: string }[] = [];
      for (let i = 0; i < numActions; i++) {
        round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
      }

      const ourCommitments = round1s.map(r => r.commitments).join('|');
      await relay.sendMessage(
        roomCode.trim(),
        participantId,
        new TextEncoder().encode(`C:${ourCommitments}`),
      );

      setProgress(`round 1: waiting for ${ms.threshold - 1} co-signer(s)...`);
      await waitForUntil(
        () => peerCommitsRawRef.current.length >= ms.threshold - 1,
        sessionDeadline,
      );

      // round 1 also waits on the network. Signing `approved` already makes a
      // late swap harmless, but there is no reason to release shares into a
      // session we know has been tampered with.
      if (supersededRef.current || txRef.current !== approved) {
        throw new Error('signing request changed mid-session — aborted before releasing any share');
      }

      // split each peer's "c0|c1|..." into per-action lists.
      const peerPerAction: string[][] = Array.from({ length: numActions }, () => []);
      for (const raw of peerCommitsRawRef.current) {
        const parts = raw.split('|');
        if (parts.length < numActions) {
          throw new Error(`peer sent ${parts.length} commitments but ${numActions} actions needed`);
        }
        for (let i = 0; i < numActions; i++) {
          peerPerAction[i]!.push(parts[i]!);
        }
      }

      for (let i = 0; i < numActions; i++) {
        setProgress(`round 2: signing action ${i + 1}/${numActions}...`);
        const allCommitments = [round1s[i]!.commitments, ...peerPerAction[i]!];
        const share = await frostSpendSignInWorker(
          secrets.ephemeralSeed,
          secrets.keyPackage,
          round1s[i]!.nonces,
          sighash,
          alphas[i]!,
          allCommitments,
        );
        await relay.sendMessage(
          roomCode.trim(),
          participantId,
          new TextEncoder().encode(`S:${i}:${share}`),
        );
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
    if (!zat) {
      return '0';
    }
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
    // FROST multisig wallets store the `uview1…` string in `orchardFvk`;
    // `ufvk` is always undefined for them.
    return (
      <AirgapJoinerWrapper
        ms={ms}
        walletLabel={activeWallet.label}
        walletAddress={activeWallet.address}
        orchardFvkUview={activeWallet.orchardFvk}
        mainnet={activeWallet.mainnet}
      />
    );
  }

  return (
    <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
      {PasswordModal}
      <div className='mb-4 rounded-lg border border-border-soft bg-elev-1 p-3'>
        <p className='text-label text-fg-muted'>signing as</p>
        <p className='mt-0.5 text-sm font-medium truncate'>{activeWallet.label}</p>
        <p className='text-label font-mono text-fg-muted truncate'>
          {activeWallet.address.slice(0, 16)}...{activeWallet.address.slice(-8)}
        </p>
        <span className='mt-1 inline-block rounded-md bg-primary/10 px-2 py-0.5 text-label font-medium text-zigner-gold'>
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
          <span className='i-ph-circle-notch size-3.5 animate-spin' />
          {progress}
          <span className='tabular-nums text-fg-dim'>{countdown}s</span>
        </div>
      )}

      {step === 'review' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3'>
            <p className='text-label tracking-wider text-yellow-400'>review transaction</p>
          </div>

          <div className='rounded-lg border border-border-soft bg-elev-1 p-3 flex flex-col gap-2.5'>
            <div>
              <p className='text-label tracking-wider text-fg-muted'>from</p>
              <p className='mt-0.5 text-xs font-medium'>{activeWallet.label}</p>
              <p className='mt-0.5 break-all font-mono text-label text-fg-muted'>
                {activeWallet.address}
              </p>
            </div>
            <div className='border-t border-border-soft' />
            <div>
              <p className='text-label tracking-wider text-fg-muted'>to</p>
              <p className='mt-0.5 break-all font-mono text-label'>{recipient}</p>
            </div>
            <div className='border-t border-border-soft' />
            <div className='flex items-baseline justify-between'>
              <span className='text-label tracking-wider text-fg-muted'>amount</span>
              <Sensitive className='tabular text-sm font-medium'>
                {formatZec(amountZat)} ZEC
              </Sensitive>
            </div>
            <div className='flex items-baseline justify-between'>
              <span className='text-label tracking-wider text-fg-muted'>fee (host claim)</span>
              <Sensitive className='tabular text-xs text-fg-muted'>
                {formatZec(feeZat)} ZEC
              </Sensitive>
            </div>
            {/* The fee is the one number on this screen that is NOT derived
                from the bytes — see assessClaimedFee(). Say so rather than
                letting it sit next to verified fields looking equally solid. */}
            <p className='text-label text-fg-dim'>
              fee is reported by the host and cannot be checked against the transaction bytes
            </p>
          </div>

          {/* verifier verdict */}
          {verdict.kind === 'pending' && (
            <div className='rounded-lg border border-border-soft bg-elev-1 p-2.5 text-label text-fg-muted flex items-center gap-2'>
              <span className='i-ph-circle-notch size-3 animate-spin' />
              verifying tx bytes match host claim…
            </div>
          )}
          {verdict.kind === 'match' && (
            <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-2.5 text-label text-green-400 flex items-start gap-2'>
              <span className='i-ph-shield-check size-3.5 mt-0.5 shrink-0' />
              <span>
                recipient, amount and sighash verified against the transaction bytes
                {verdict.changeZat > 0n && (
                  <>
                    {' '}
                    (<Sensitive>+{formatZec(verdict.changeZat.toString())} ZEC</Sensitive> change to
                    self)
                  </>
                )}
                . the fee is not covered by this check.
              </span>
            </div>
          )}
          {verdict.kind === 'refuse' && (
            <div className='rounded-lg border border-red-500/60 bg-red-500/10 p-3 flex flex-col gap-2'>
              <div className='flex items-center gap-2 text-body font-medium text-red-400'>
                <span className='i-ph-shield-warning size-4' />
                cannot verify - signing refused
              </div>
              <ul className='text-label text-red-300/90 list-disc pl-4 space-y-0.5'>
                {verdict.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {verdict.kind === 'mismatch' && (
            <div className='rounded-lg border border-red-500/60 bg-red-500/10 p-3 flex flex-col gap-2'>
              <div className='flex items-center gap-2 text-body font-medium text-red-400'>
                <span className='i-ph-shield-warning size-4' />
                mismatch - host claim disagrees with tx bytes
              </div>
              <ul className='text-label text-red-300/90 list-disc pl-4 space-y-0.5'>
                {verdict.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              {parsed && parsed.actions.some(a => a.decrypted && !a.is_change) && (
                <div className='rounded border border-red-500/30 bg-red-500/5 p-2 text-label font-mono text-red-300/80'>
                  <p className='text-label tracking-wider text-red-400/80 mb-1'>derived outputs</p>
                  {parsed.actions
                    .filter(a => a.decrypted && !a.is_change)
                    .map(a => (
                      <div key={a.index} className='break-all'>
                        action {a.index}:{' '}
                        <Sensitive>{formatZec(String(a.amount_zat))} ZEC</Sensitive> →{' '}
                        {a.recipient_raw_hex ? `${a.recipient_raw_hex.slice(0, 16)}…` : 'unknown'}
                      </div>
                    ))}
                </div>
              )}
              <label className='flex items-start gap-2 text-label text-red-300/90 cursor-pointer mt-1'>
                <input
                  type='checkbox'
                  checked={acknowledged}
                  onChange={e => setAcknowledged(e.target.checked)}
                  className='mt-0.5'
                />
                <span>I see the mismatch. Override and sign at my own risk.</span>
              </label>
            </div>
          )}

          <p className='text-label text-fg-muted'>
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
              disabled={!verdictAllowsSigning(verdict, acknowledged)}
              className='rounded-lg border border-primary/40 bg-primary/5 py-2 text-xs text-zigner-gold hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
            >
              {verdict.kind === 'mismatch' ? 'approve anyway' : 'approve & sign'}
            </button>
          </div>
        </div>
      )}

      {step === 'signing' && (
        <div className='flex flex-col items-center gap-4'>
          {recipient && (
            <div className='w-full rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3'>
              <p className='text-label tracking-wider text-yellow-400'>signing</p>
              <p className='mt-0.5 text-sm font-medium text-yellow-300'>
                <Sensitive>{formatZec(amountZat)} ZEC</Sensitive> →{' '}
                <span className='font-mono text-label'>
                  {recipient.slice(0, 16)}…{recipient.slice(-6)}
                </span>
              </p>
            </div>
          )}
          <div className='flex items-center gap-2 text-xs text-fg-muted'>
            <span className='i-ph-circle-notch size-3.5 animate-spin' />
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
            onClick={() => {
              teardown();
              setStep('input');
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

type WrapperPhase = 'input' | 'active' | 'done';

// airgap joiner: paste room code → delegate to FrostAirgapJoinerSignFlow,
// then land on a green "shares sent" confirmation (matches mnemonic joiner).
const AirgapJoinerWrapper = ({
  ms,
  walletLabel,
  walletAddress,
  orchardFvkUview,
  mainnet,
}: {
  ms: {
    publicKeyPackage: string;
    threshold: number;
    maxSigners: number;
    relayUrl?: string;
    zignerWalletId?: string;
  };
  walletLabel: string;
  walletAddress: string;
  orchardFvkUview?: string;
  mainnet: boolean;
}) => {
  const [room, setRoom] = useState('');
  const [phase, setPhase] = useState<WrapperPhase>('input');
  const [error, setError] = useState('');

  const reset = () => {
    setPhase('input');
    setRoom('');
    setError('');
  };

  const WalletCard = () => (
    <div className='mb-4 rounded-lg border border-border-soft bg-elev-1 p-3'>
      <p className='text-label text-fg-muted'>signing as</p>
      <p className='mt-0.5 text-sm font-medium truncate'>{walletLabel}</p>
      <p className='text-label font-mono text-fg-muted truncate'>
        {walletAddress.slice(0, 16)}...{walletAddress.slice(-8)}
      </p>
      <span className='mt-1 inline-block rounded-md bg-primary/10 px-2 py-0.5 text-label font-medium text-zigner-gold'>
        {ms.threshold}/{ms.maxSigners} · airgap
      </span>
    </div>
  );

  if (phase === 'active') {
    if (error) {
      return (
        <SettingsScreen title='co-sign' backPath={PopupPath.MULTISIG}>
          <div className='flex flex-col gap-3'>
            <div className='rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-400'>
              {error}
            </div>
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
        ms={{ ...ms, orchardFvkUview, mainnet }}
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
            signing shares sent - coordinator will broadcast the transaction
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
