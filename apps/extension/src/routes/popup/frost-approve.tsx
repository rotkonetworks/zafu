/**
 * frost-approve - FROST approval popup for external dapps
 *
 * opened by zafu_frost_create / zafu_frost_join / zafu_frost_sign
 * runs the FROST operation on user approval, sends result back via
 * zafu_frost_result internal message.
 */

import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../state';
import {
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostDeriveAddressInWorker,
  frostDeriveAddressFromSkInWorker,
  frostDeriveUfvkInWorker,
  frostSignRound1InWorker,
  frostSpendSignInWorker,
  frostInspectPcztOutputsInWorker,
} from '../../state/keyring/network-worker';
import { computeEscrowVerdict } from './send/frost-multisig/multisig-verifier';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { hexToBytes } from '@repo/wallet/networks';
import { FrostdRelayClient } from '../../state/keyring/frostd-relay-client';
import { buildRelayIdentity, getOrCreateRelayIdentity } from '../../state/keyring/relay-identity';
import { FROST_SESSION_TIMEOUT_MS, waitForUntil } from '../../state/frost-session';
import { usePasswordGate } from '../../hooks/password-gate';
import { Sensitive } from '../../components/sensitive';

interface PokerPayoutOutput {
  address: string;
  amount_zat: number;
}

type Phase = 'confirm' | 'running' | 'review' | 'complete' | 'error';

/** wait for condition with timeout */
function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) {
      resolve();
      return;
    }
    const start = Date.now();
    const iv = setInterval(() => {
      if (check()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('timeout'));
      }
    }, 500);
  });
}

function sendResult(requestId: string, result: unknown) {
  void chrome.runtime.sendMessage({
    type: 'zafu_frost_result',
    requestId,
    result,
  });
}

export const FrostApprove = () => {
  const [params] = useSearchParams();
  const action = params.get('action') || '';
  const app = params.get('app') || 'unknown';
  const MAX_FROST_SIGNERS = 15;
  const threshold = Math.min(Number(params.get('threshold')) || 2, MAX_FROST_SIGNERS);
  const maxSigners = Math.min(Number(params.get('maxSigners')) || 3, MAX_FROST_SIGNERS);
  const relayUrl = params.get('relayUrl') || 'wss://zcash.rotko.net';
  const roomCode = params.get('roomCode') || '';
  /**
   * The other signers' frostd relay public keys, comma-separated.
   *
   * frostd fixes a session's participants at creation, so a caller that omits
   * these cannot open one. Failing here with a clear message beats failing
   * inside the relay with a membership error.
   */
  const relayPeerKeys = (params.get('relayPeerKeys') || '')
    .split(',')
    .map(k => k.trim())
    .filter(k => k !== '');
  const sighashHex = params.get('sighashHex') || '';
  const labelPrefix = params.get('labelPrefix') || 'multisig';
  const requestId = params.get('requestId') || '';
  const planJson = params.get('planJson') || '';
  const feeZat = Number(params.get('feeZat')) || 0;
  const multisigLabel = params.get('multisigLabel') || '';
  const hide = params.get('hide') === '1';
  const plan: PokerPayoutOutput[] = planJson
    ? (() => {
        try {
          return JSON.parse(planJson) as PokerPayoutOutput[];
        } catch {
          return [];
        }
      })()
    : [];

  const [phase, setPhase] = useState<Phase>('confirm');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);
  const getMultisigSecrets = useStore(s => s.keyRing.getMultisigSecrets);
  const keyInfos = useStore(s => s.keyRing.keyInfos);
  const zcashWallets = useStore(s => s.wallets.zcashWallets);
  // find active multisig vault for signing
  const multisigVault = keyInfos.find(k => k.type === 'frost-multisig');

  // explicit password prompt before runPokerSign decrypts the FROST share
  const { requestAuth, PasswordModal } = usePasswordGate();

  // poker-sign review gate: after the escrow PCZT is verified we show its
  // OVK-decoded outputs and block on an explicit user confirm before signing.
  const reviewResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const [reviewOutputs, setReviewOutputs] = useState<
    { recipientUa: string; amountZat: bigint }[] | null
  >(null);
  const [reviewChangeZat, setReviewChangeZat] = useState<bigint>(0n);
  const [reviewSendZat, setReviewSendZat] = useState<bigint>(0n);
  // the sighash recomputed from the PCZT — equal to the one our share signs,
  // already asserted by computeEscrowVerdict. Shown so the user can see the bind.
  const [reviewSighash, setReviewSighash] = useState('');

  const awaitReview = (
    v: {
      outputs: { recipientUa: string; amountZat: bigint }[];
      sendZat: bigint;
      changeZat: bigint;
    },
    sighashHex: string,
  ) =>
    new Promise<boolean>(resolve => {
      setReviewOutputs(v.outputs);
      setReviewSendZat(v.sendZat);
      setReviewChangeZat(v.changeZat);
      setReviewSighash(sighashHex);
      setPhase('review');
      reviewResolveRef.current = resolve;
    });

  const resolveReview = (ok: boolean) => {
    reviewResolveRef.current?.(ok);
    reviewResolveRef.current = null;
  };

  const deny = () => {
    sendResult(requestId, { error: 'user denied' });
    window.close();
  };

  const approve = async () => {
    setPhase('running');
    try {
      if (action === 'frost-create') {
        await runDkgCreate();
      } else if (action === 'frost-join') {
        await runDkgJoin();
      } else if (action === 'dkg-join') {
        await runDkgJoinV2();
      } else if (action === 'frost-sign') {
        await runSign();
      } else if (action === 'poker-sign') {
        await runPokerSign();
      } else {
        throw new Error(`unknown action: ${action}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPhase('error');
      sendResult(requestId, { error: msg });
    }
  };

  /**
   * The DKG group shape is consent-bearing: a share issued into a 1-of-3 group
   * is a share the coordinator can spend from alone. The confirm screen shows
   * `threshold`/`maxSigners`, so those are what the user approved — anything the
   * relay says must equal them, not replace them.
   */
  const assertApprovedGroup = (relayThreshold: number, relayMaxSigners: number) => {
    if (relayThreshold !== threshold || relayMaxSigners !== maxSigners) {
      throw new Error(
        `refusing to run DKG: you approved a ${threshold}-of-${maxSigners} group but the ` +
          `coordinator asked for ${relayThreshold}-of-${relayMaxSigners}. ` +
          `A lowered threshold would let the coordinator spend without you.`,
      );
    }
  };

  /**
   * Build a relay client for this approval.
   *
   * The ceremony id is the room code where we have one, and the sighash
   * otherwise: stable for the flow, and not shared across unrelated groups,
   * so a relay operator cannot link a user's sessions.
   */
  const relayClient = async (): Promise<FrostdRelayClient> => {
    if (relayPeerKeys.length === 0) {
      throw new Error(
        'this request has no relayPeerKeys - every signer must be listed before a session exists',
      );
    }
    const ceremonyId = roomCode !== '' ? roomCode : sighashHex;
    const stored = await getOrCreateRelayIdentity(ceremonyId);
    const identity = await buildRelayIdentity(stored, relayPeerKeys);
    return new FrostdRelayClient(relayUrl, identity);
  };

  const runDkgCreate = async () => {
    const abort = new AbortController();
    const relay = await relayClient();

    setStatus('creating room...');
    const room = await relay.createRoom(threshold, maxSigners, 600);

    setStatus(`room: ${room.roomCode} - waiting for ${maxSigners - 1} participants...`);

    const round1 = await frostDkgPart1InWorker(maxSigners, threshold);
    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    const peerBroadcasts: string[] = [];
    const peerRound2: string[] = [];
    let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';

    const prefixed = `DKG:${threshold}:${maxSigners}:${round1.broadcast}`;
    await relay.sendMessage(room.roomCode, pid, new TextEncoder().encode(prefixed));

    void relay.joinRoom(
      room.roomCode,
      pid,
      event => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (dkgPhase === 'round1') {
            peerBroadcasts.push(text);
          } else if (dkgPhase === 'round2') {
            peerRound2.push(text);
          }
        }
      },
      abort.signal,
    );

    setStatus('round 1 - collecting commitments...');
    await waitFor(() => peerBroadcasts.length >= maxSigners - 1, 120_000);

    dkgPhase = 'round2';
    setStatus('round 2 - exchanging key shares...');
    const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
    for (const pkg of round2.peer_packages) {
      await relay.sendMessage(room.roomCode, pid, new TextEncoder().encode(pkg));
    }

    await waitFor(() => peerRound2.length >= maxSigners - 1, 120_000);

    setStatus('round 3 - finalizing...');
    const round3 = await frostDkgPart3InWorker(round2.secret, peerBroadcasts, peerRound2);
    const addr = await frostDeriveAddressInWorker(round3.public_key_package, 0);

    await newFrostMultisigKey({
      label: `${threshold}-of-${maxSigners} (${app})`,
      address: addr,
      // dapp-initiated ceremonies predate the sk-broadcast/FVK-echo protocol,
      // so no group viewing key is available to store here
      orchardFvk: '',
      keyPackage: round3.key_package,
      publicKeyPackage: round3.public_key_package,
      ephemeralSeed: round3.ephemeral_seed,
      threshold,
      maxSigners,
      relayUrl,
      createdByOrigin: app,
    });

    abort.abort();
    const res = {
      success: true,
      address: addr,
      roomCode: room.roomCode,
      publicKeyPackage: round3.public_key_package,
    };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  const runDkgJoin = async () => {
    const abort = new AbortController();
    const relay = await relayClient();

    setStatus(`joining room ${roomCode}...`);

    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    const peerBroadcasts: string[] = [];
    const peerRound2: string[] = [];
    let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';
    let parsedThreshold = threshold;
    let parsedMaxSigners = maxSigners;

    void relay.joinRoom(
      roomCode,
      pid,
      event => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          // coordinator's first message has DKG params prefix
          const match = /^DKG:(\d+):(\d+):([\s\S]*)$/.exec(text);
          if (match) {
            parsedThreshold = Number(match[1]);
            parsedMaxSigners = Number(match[2]);
            if (dkgPhase === 'round1') {
              peerBroadcasts.push(match[3]!);
            }
          } else if (dkgPhase === 'round1') {
            peerBroadcasts.push(text);
          } else if (dkgPhase === 'round2') {
            peerRound2.push(text);
          }
        }
      },
      abort.signal,
    );

    setStatus('round 1 - collecting commitments...');
    // wait for at least one message to learn params
    await waitFor(() => peerBroadcasts.length >= 1, 120_000);

    // same binding as runDkgJoinV2: the coordinator announces T:N over an
    // unauthenticated relay, and the confirm screen showed the approved pair.
    assertApprovedGroup(parsedThreshold, parsedMaxSigners);

    const round1 = await frostDkgPart1InWorker(parsedMaxSigners, parsedThreshold);
    await relay.sendMessage(roomCode, pid, new TextEncoder().encode(round1.broadcast));

    await waitFor(() => peerBroadcasts.length >= parsedMaxSigners - 1, 120_000);

    dkgPhase = 'round2';
    setStatus('round 2 - exchanging key shares...');
    const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
    for (const pkg of round2.peer_packages) {
      await relay.sendMessage(roomCode, pid, new TextEncoder().encode(pkg));
    }

    await waitFor(() => peerRound2.length >= parsedMaxSigners - 1, 120_000);

    setStatus('round 3 - finalizing...');
    const round3 = await frostDkgPart3InWorker(round2.secret, peerBroadcasts, peerRound2);
    const addr = await frostDeriveAddressInWorker(round3.public_key_package, 0);

    await newFrostMultisigKey({
      label: `${parsedThreshold}-of-${parsedMaxSigners} (${app})`,
      address: addr,
      // dapp-initiated ceremonies predate the sk-broadcast/FVK-echo protocol,
      // so no group viewing key is available to store here
      orchardFvk: '',
      keyPackage: round3.key_package,
      publicKeyPackage: round3.public_key_package,
      ephemeralSeed: round3.ephemeral_seed,
      threshold: parsedThreshold,
      maxSigners: parsedMaxSigners,
      relayUrl,
      createdByOrigin: app,
    });

    abort.abort();
    const res = { success: true, address: addr, roomCode };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  // generic DKG joiner — mirrors multisig/join.tsx's R1:T:N:SK / R2 / FVK-echo flow
  const runDkgJoinV2 = async () => {
    const abort = new AbortController();
    const sessionDeadline = Date.now() + FROST_SESSION_TIMEOUT_MS;
    const relay = await relayClient();
    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    let parsedThreshold = 0;
    let parsedMaxSigners = 0;
    let fvkSk = '';
    const peerBroadcasts: string[] = [];
    const peerRound2: string[] = [];
    const peerFvks: string[] = [];

    setStatus('joining room...');
    void relay.joinRoom(
      roomCode,
      pid,
      event => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          const r1 = /^R1:(?:(\d+):(\d+):SK:([0-9a-fA-F]{64}):)?([\s\S]*)$/.exec(text);
          if (r1) {
            if (r1[1] && r1[2] && r1[3]) {
              parsedThreshold = Number(r1[1]);
              parsedMaxSigners = Number(r1[2]);
              fvkSk = r1[3];
            }
            peerBroadcasts.push(r1[4]!);
            return;
          }
          const r2 = /^R2:([\s\S]*)$/.exec(text);
          if (r2) {
            peerRound2.push(r2[1]!);
            return;
          }
          const fvk = /^FVK:([\s\S]*)$/.exec(text);
          if (fvk) {
            peerFvks.push(fvk[1]!);
            return;
          }
        }
      },
      abort.signal,
    );

    setStatus('waiting for host...');
    await waitForUntil(
      () => parsedThreshold > 0 && parsedMaxSigners > 0 && fvkSk.length === 64,
      sessionDeadline,
    );

    // The confirm screen showed the user "{threshold}-of-{maxSigners}". Those
    // are the only numbers they consented to. The relay is unauthenticated, so
    // R1's T:N is attacker-controlled: accepting it would let a coordinator
    // show "2-of-3" and then seat the share in a 1-of-3 group it alone can
    // spend from. Bind the ceremony to what was approved.
    assertApprovedGroup(parsedThreshold, parsedMaxSigners);

    setStatus('round 1: generating commitment...');
    const round1 = await frostDkgPart1InWorker(parsedMaxSigners, parsedThreshold);
    await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`R1:${round1.broadcast}`));

    setStatus(`round 1: waiting for ${parsedMaxSigners - 1} participant(s)...`);
    await waitForUntil(() => peerBroadcasts.length >= parsedMaxSigners - 1, sessionDeadline);

    setStatus('round 2: exchanging key shares...');
    const round2 = await frostDkgPart2InWorker(round1.secret, peerBroadcasts);
    for (const pkg of round2.peer_packages) {
      await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`R2:${pkg}`));
    }

    const expectedR2 = (parsedMaxSigners - 1) ** 2;
    setStatus(`round 2: waiting for ${expectedR2} peer package(s)...`);
    await waitForUntil(() => peerRound2.length >= expectedR2, sessionDeadline);

    setStatus('round 3: finalizing...');
    const round3 = await frostDkgPart3InWorker(round2.secret, peerBroadcasts, peerRound2);

    // mainnet=true matches multisig/join.tsx; param-ize when callers need testnet/regtest
    const addrRaw = await frostDeriveAddressFromSkInWorker(round3.public_key_package, fvkSk, 0);
    const addr = encodeOrchardUnifiedAddress(hexToBytes(addrRaw), true);
    const orchardFvk = await frostDeriveUfvkInWorker(round3.public_key_package, fvkSk, true);

    setStatus('verifying viewing key agreement...');
    await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`FVK:${orchardFvk}`));
    await waitForUntil(() => peerFvks.length >= parsedMaxSigners - 1, sessionDeadline);
    for (const peerFvk of peerFvks) {
      if (peerFvk !== orchardFvk) {
        throw new Error(
          `FVK mismatch: peer saw a different viewing key - ours ends …${orchardFvk.slice(-8)}, theirs ends …${peerFvk.slice(-8)}`,
        );
      }
    }

    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const label = `${labelPrefix}-${ts}`;
    await newFrostMultisigKey({
      label,
      address: addr,
      orchardFvk,
      keyPackage: round3.key_package,
      publicKeyPackage: round3.public_key_package,
      ephemeralSeed: round3.ephemeral_seed,
      threshold: parsedThreshold,
      maxSigners: parsedMaxSigners,
      relayUrl,
      hidden: hide,
      createdByOrigin: app,
    });

    abort.abort();
    const res = { success: true, address: addr, orchardFvk, roomCode };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  const runSign = async () => {
    if (!multisigVault) {
      throw new Error('no multisig wallet found');
    }

    // wallet-password gate before unsealing the FROST share. Mirrors
    // runPokerSign — session-unlock alone is not enough to release the
    // share for a sighash whose semantics the user can't independently
    // verify.
    setStatus('awaiting wallet password...');
    const authorized = await requestAuth();
    if (!authorized) {
      sendResult(requestId, { error: 'user denied (password)' });
      window.close();
      return;
    }

    const abort = new AbortController();
    const relay = await relayClient();
    const secrets = await getMultisigSecrets(multisigVault.id);
    if (!secrets) {
      throw new Error('failed to decrypt multisig secrets');
    }

    setStatus('joining signing session...');

    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    // parse alphas from coordinator message or use sighash as single alpha
    const alphas = [sighashHex];

    const peerCommitments: string[] = [];
    const peerShares: string[] = [];
    let sigPhase: 'commitments' | 'shares' = 'commitments';

    // join room BEFORE sending to avoid race condition
    void relay.joinRoom(
      roomCode,
      pid,
      event => {
        if (event.type === 'message') {
          const text = new TextDecoder().decode(event.message.payload);
          if (text.startsWith('C:') && sigPhase === 'commitments') {
            peerCommitments.push(text.slice(2));
          } else if (text.startsWith('S:')) {
            peerShares.push(text.slice(2));
          }
        }
      },
      abort.signal,
    );

    setStatus('generating commitments...');
    // One fresh nonce pair PER alpha. FROST nonces are strictly single-use:
    // two signatures produced under the same nonces reveal the signing share by
    // simple algebra. `alphas` has length 1 today, so the old shared-`round1`
    // loop was not yet exploitable — but that is an invariant held by a
    // neighbouring line, not by the code that depends on it. Index the nonces
    // by alpha so growing `alphas` can never silently leak the share.
    const round1s = await Promise.all(
      alphas.map(() => frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage)),
    );

    // send commitments after joining
    await relay.sendMessage(
      roomCode,
      pid,
      new TextEncoder().encode(`C:${round1s.map(r => r.commitments).join('|')}`),
    );

    // use wallet's stored threshold, not attacker-controlled URL param
    const walletThreshold = (multisigVault.insensitive?.['threshold'] as number) || threshold;
    setStatus('waiting for other signers...');
    await waitFor(() => peerCommitments.length >= walletThreshold - 1, 120_000);

    sigPhase = 'shares';
    setStatus('signing...');

    for (const [i, alpha] of alphas.entries()) {
      const r1 = round1s[i]!;
      const allCommitments = [r1.commitments, ...peerCommitments];
      const share = await frostSpendSignInWorker(
        secrets.ephemeralSeed,
        secrets.keyPackage,
        r1.nonces,
        sighashHex,
        alpha,
        allCommitments,
      );
      await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`S:${share}`));
    }

    abort.abort();
    const res = { success: true, signed: true };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  // joiner-side PCZT signing — host (poker-escrow) drives SIGN/C/S wire same as multisig/sign.tsx
  const runPokerSign = async () => {
    // Re-sanitize the URL param defensively (external-easteregg already does
    // this on the message-listener boundary, but the popup is its own trust
    // boundary). Same charset as the listener side.
    const sanitizedLabel = multisigLabel.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    const vault = sanitizedLabel
      ? keyInfos.find(k => k.type === 'frost-multisig' && k.name?.startsWith(sanitizedLabel))
      : multisigVault;
    if (!vault) {
      throw new Error('no matching multisig wallet found');
    }

    // wallet-password gate before unsealing the FROST share
    setStatus('awaiting wallet password...');
    const authorized = await requestAuth();
    if (!authorized) {
      sendResult(requestId, { error: 'user denied (password)' });
      window.close();
      return;
    }

    const abort = new AbortController();
    const relay = await relayClient();
    const secrets = await getMultisigSecrets(vault.id);
    if (!secrets) {
      throw new Error('failed to decrypt multisig secrets');
    }

    setStatus(`joining signing room ${roomCode}...`);
    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    // Latched escrow request. Set once, by the FIRST SIGN:. The relay is
    // unauthenticated, so a later SIGN: is an attempt to swap the transaction
    // out from under the review the user is in the middle of — it poisons the
    // session rather than overwriting this.
    const latched: {
      req: { sighash: string; alphas: string[]; pcztHex: string } | null;
      raw: string;
      superseded: boolean;
    } = { req: null, raw: '', superseded: false };
    const peerCommits: string[] = [];
    const peerShares: Record<number, string> = {};

    void relay.joinRoom(
      roomCode,
      pid,
      event => {
        if (event.type !== 'message') {
          return;
        }
        const text = new TextDecoder().decode(event.message.payload);
        const sg = /^SIGN:([0-9a-fA-F]+):([^:]+):([^:]+):(\d+):(\d+)(?::([0-9a-fA-F]+))?$/.exec(
          text,
        );
        if (sg) {
          if (latched.req) {
            // byte-identical redelivery of room history is benign; a different
            // request is a takeover attempt.
            if (text !== latched.raw) {
              latched.superseded = true;
            }
            return;
          }
          latched.req = { sighash: sg[1]!, alphas: sg[2]!.split(','), pcztHex: sg[6] ?? '' };
          latched.raw = text;
          return;
        }
        const cm = /^C:([\s\S]*)$/.exec(text);
        if (cm) {
          peerCommits.push(cm[1]!);
          return;
        }
        const sm = /^S:(\d+):(.+)$/.exec(text);
        if (sm) {
          peerShares[Number(sm[1])] = sm[2]!;
        }
      },
      abort.signal,
    );

    setStatus('waiting for host SIGN...');
    await waitFor(() => latched.req !== null, 120_000);

    // ── snapshot, then verify, then sign the snapshot ──
    // `approved` is frozen here. Everything below — the verdict, the review the
    // user confirms, and the shares we release — refers to this one object, so
    // a SIGN: arriving during the review cannot become the thing we sign.
    const approved = latched.req;
    if (!approved) {
      throw new Error('no SIGN: request received');
    }

    // The escrow builds the PCZT, so it is the only truth: bind the sighash we
    // are about to sign to the one recomputed from the PCZT, then show the user
    // its OVK-decoded outputs. The dapp's URL `plan` is never trusted here.
    if (!approved.pcztHex) {
      throw new Error('escrow did not publish a PCZT — refusing to sign blind');
    }
    const zw = zcashWallets.find(w => w.vaultId === vault.id);
    if (!zw?.orchardFvk) {
      throw new Error('multisig wallet has no viewing key on file — cannot verify request');
    }
    setStatus('verifying request against escrow PCZT...');
    const parsed = await frostInspectPcztOutputsInWorker(approved.pcztHex, zw.orchardFvk);
    const verdict = computeEscrowVerdict({
      parsed,
      claimedSighashHex: approved.sighash,
      mainnet: zw.mainnet,
    });
    if (verdict.kind !== 'ok') {
      throw new Error(verdict.reasons.join(' — '));
    }
    // computeEscrowVerdict already asserted parsed.computed_sighash_hex === approved.sighash,
    // so either is the bound value; show the recomputed one as the on-device truth.
    const confirmed = await awaitReview(verdict, parsed.computed_sighash_hex ?? approved.sighash);
    if (!confirmed) {
      abort.abort();
      sendResult(requestId, { error: 'user denied after review' });
      window.close();
      return;
    }
    // The review is an unbounded human-time await — precisely the window an
    // attacker aims at. Signing `approved` already makes a swap ineffective;
    // refuse outright so the user is told rather than silently signing #1 while
    // the escrow believes it asked for #2.
    if (latched.superseded) {
      throw new Error(
        'the escrow published a second, different transaction while you were reviewing — ' +
          'nothing was signed. re-request to review the new transaction.',
      );
    }
    setPhase('running');

    const n = approved.alphas.length;
    setStatus(`round 1: generating ${n} commitment(s)...`);
    const round1s: { nonces: string; commitments: string }[] = [];
    for (let i = 0; i < n; i++) {
      round1s.push(await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage));
    }
    const commitsCsv = round1s.map(r => r.commitments).join('|');
    await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`C:${commitsCsv}`));

    setStatus('round 1: waiting for host commitments...');
    await waitFor(() => peerCommits.length >= 1, 120_000);
    const hostCommits = peerCommits[0]!.split('|');
    if (hostCommits.length !== n) {
      throw new Error(`host sent ${hostCommits.length} commits, expected ${n}`);
    }

    for (let i = 0; i < n; i++) {
      setStatus(`round 2: signing action ${i + 1}/${n}...`);
      const allCommits = [round1s[i]!.commitments, hostCommits[i]!];
      const share = await frostSpendSignInWorker(
        secrets.ephemeralSeed,
        secrets.keyPackage,
        round1s[i]!.nonces,
        approved.sighash,
        approved.alphas[i]!,
        allCommits,
      );
      await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`S:${i}:${share}`));
    }

    setStatus('done - host will broadcast the transaction');
    abort.abort();
    const res = { success: true, signed: true, actions: n };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  const actionLabel =
    action === 'frost-create'
      ? 'Create Multisig'
      : action === 'frost-join'
        ? 'Join Multisig'
        : action === 'dkg-join'
          ? 'Join Multisig'
          : action === 'frost-sign'
            ? 'Sign Transaction'
            : action === 'poker-sign'
              ? 'Approve Signing'
              : action;

  return (
    <div className='flex h-full min-h-0 flex-col p-4 gap-4'>
      <div className='shrink-0 text-center'>
        <span className='kicker'>frost multisig</span>
        <h2 className='mt-1 text-title text-fg-high lowercase tracking-[-0.01em]'>{actionLabel}</h2>
        <p className='mt-1 text-label text-fg-dim lowercase'>requested by {app}</p>
      </div>

      {phase === 'confirm' && (
        <div className='flex flex-col gap-4 flex-1'>
          <div className='rounded-md border border-border-soft bg-elev-1 p-3 text-xs space-y-2 text-fg'>
            {action === 'frost-create' && (
              <>
                <p>
                  Create a{' '}
                  <span className='tabular text-zigner-gold'>
                    {threshold}-of-{maxSigners}
                  </span>{' '}
                  FROST multisig wallet.
                </p>
                <p className='text-fg-muted'>
                  This generates a shared key via distributed key generation. All participants must
                  be online.
                </p>
              </>
            )}
            {action === 'frost-join' && (
              <>
                <p>
                  Join FROST DKG room: <span className='tabular text-zigner-gold'>{roomCode}</span>
                </p>
                {/* the group shape must be *shown* here, because it is what the
                    ceremony is bound to — see assertApprovedGroup(). */}
                <p>
                  as a{' '}
                  <span className='tabular text-zigner-gold'>
                    {threshold}-of-{maxSigners}
                  </span>{' '}
                  group
                </p>
                <p className='text-fg-muted'>
                  You will participate in key generation to create a shared multisig wallet. The
                  ceremony is aborted if the coordinator asks for a different group size.
                </p>
              </>
            )}
            {action === 'dkg-join' && (
              <>
                <p>
                  Join{' '}
                  <span className='tabular text-zigner-gold'>
                    {threshold}-of-{maxSigners}
                  </span>{' '}
                  multisig DKG
                </p>
                <p className='text-fg-muted tabular'>label: {labelPrefix}-…</p>
                <p className='text-fg-muted'>Your share stays on this device.</p>
              </>
            )}
            {action === 'frost-sign' && (
              <>
                <p>Co-sign a transaction with your FROST key share.</p>
                <p className='text-fg-muted tabular break-all'>
                  sighash: {sighashHex.slice(0, 16)}...{sighashHex.slice(-16)}
                </p>
              </>
            )}
            {action === 'poker-sign' && (
              <>
                <p>Co-sign a transaction requested by an escrow.</p>
                <div className='mt-1 space-y-1'>
                  {plan.map((o, i) => (
                    <p key={i} className='text-fg-muted tabular break-all'>
                      → {o.address.slice(0, 14)}…{o.address.slice(-8)}
                      <span className='text-zigner-gold'>
                        {' '}
                        <Sensitive>{(o.amount_zat / 1e8).toFixed(8)} ZEC</Sensitive>
                      </span>
                    </p>
                  ))}
                  <p className='text-fg-dim tabular'>
                    fee <Sensitive>{(feeZat / 1e8).toFixed(8)} ZEC</Sensitive>
                  </p>
                </div>
                <p className='text-fg-muted'>
                  Requested amounts shown above. You will re-confirm the exact outputs decoded from
                  the escrow&apos;s signed tx before your share is released.
                </p>
              </>
            )}
            <p className='text-fg-dim tabular'>relay: {relayUrl}</p>
          </div>

          <div className='flex shrink-0 gap-2 mt-auto'>
            <Button variant='secondary' className='flex-1' onClick={deny}>
              deny
            </Button>
            <Button className='flex-1' onClick={approve}>
              approve
            </Button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className='flex flex-col items-center gap-3 flex-1 justify-center'>
          <span className='i-ph-circle-notch size-8 animate-spin text-zigner-gold' />
          <p className='text-data text-fg text-center lowercase'>{status}</p>
        </div>
      )}

      {phase === 'review' && reviewOutputs && (
        <div className='flex flex-col gap-3 flex-1'>
          <div className='flex items-center gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-2.5'>
            <span className='i-ph-shield-check size-5 shrink-0 text-green-400' />
            <div className='leading-tight'>
              <p className='text-xs text-green-300'>verified on-device</p>
              <p className='text-[10px] text-fg-muted'>
                outputs + sighash decoded from the escrow's signed PCZT — not the app's claim
              </p>
            </div>
          </div>

          <div className='rounded-md border border-border-soft bg-elev-1 p-3 text-xs space-y-2 text-fg'>
            <div className='space-y-1'>
              {reviewOutputs.map((o, i) => (
                <div key={i} className='flex items-baseline justify-between gap-2'>
                  <span className='text-fg-muted tabular break-all'>
                    → {o.recipientUa.slice(0, 14)}…{o.recipientUa.slice(-8)}
                  </span>
                  <Sensitive className='text-zigner-gold tabular shrink-0'>
                    {(Number(o.amountZat) / 1e8).toFixed(8)} ZEC
                  </Sensitive>
                </div>
              ))}
            </div>
            <div className='border-t border-border-soft pt-2 space-y-1'>
              <div className='flex items-baseline justify-between'>
                <span className='text-fg-muted'>total to recipients</span>
                <Sensitive className='text-fg-high tabular'>
                  {(Number(reviewSendZat) / 1e8).toFixed(8)} ZEC
                </Sensitive>
              </div>
              {reviewChangeZat > 0n && (
                <div className='flex items-baseline justify-between'>
                  <span className='text-fg-dim'>change back to vault</span>
                  <Sensitive className='text-fg-dim tabular'>
                    {(Number(reviewChangeZat) / 1e8).toFixed(8)} ZEC
                  </Sensitive>
                </div>
              )}
            </div>
          </div>

          <div className='rounded-md border border-border-soft bg-elev-1 p-2.5 text-[10px] space-y-1'>
            <div className='flex items-center gap-1.5 text-fg-muted'>
              <span className='i-ph-check size-3 shrink-0 text-green-400' />
              <span>sighash your share signs matches the PCZT</span>
            </div>
            <p className='tabular break-all text-fg-dim pl-[18px]'>
              {reviewSighash.slice(0, 24)}…{reviewSighash.slice(-24)}
            </p>
          </div>

          <div className='flex gap-2 mt-auto'>
            <Button variant='secondary' className='flex-1' onClick={() => resolveReview(false)}>
              cancel
            </Button>
            <Button className='flex-1' onClick={() => resolveReview(true)}>
              sign
            </Button>
          </div>
        </div>
      )}

      {phase === 'complete' && (
        <div className='flex flex-col items-center gap-3 flex-1 justify-center'>
          <span className='i-ph-check-circle size-10 text-green-400' />
          <p className='text-data text-fg-high lowercase'>done</p>
          {typeof result?.['address'] === 'string' && (
            <p className='text-xs tabular text-fg-muted break-all px-4'>
              {result['address'].slice(0, 20)}...
            </p>
          )}
          <Button variant='secondary' onClick={() => window.close()}>
            close
          </Button>
        </div>
      )}

      {phase === 'error' && (
        <div className='flex flex-col items-center gap-3 flex-1 justify-center'>
          <span className='i-ph-x-circle size-10 text-red-400' />
          <p className='text-data text-red-400 text-center'>{error}</p>
          <Button variant='secondary' onClick={() => window.close()}>
            close
          </Button>
        </div>
      )}

      {PasswordModal}
    </div>
  );
};
