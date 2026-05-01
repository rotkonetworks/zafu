/**
 * frost-approve - FROST approval popup for external dapps
 *
 * opened by zafu_frost_create / zafu_frost_join / zafu_frost_sign
 * runs the FROST operation on user approval, sends result back via
 * zafu_frost_result internal message.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../../state';
import {
  frostDkgPart1InWorker,
  frostDkgPart2InWorker,
  frostDkgPart3InWorker,
  frostDeriveAddressInWorker,
  frostSignRound1InWorker,
  frostSpendSignInWorker,
} from '../../state/keyring/network-worker';
import { FrostRelayClient } from '../../state/keyring/frost-relay-client';

type Phase = 'confirm' | 'running' | 'complete' | 'error';

/** wait for condition with timeout */
function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (check()) return resolve();
    const start = Date.now();
    const iv = setInterval(() => {
      if (check()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
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
  const relayUrl = params.get('relayUrl') || 'wss://zrelay.rotko.net';
  const roomCode = params.get('roomCode') || '';
  const sighashHex = params.get('sighashHex') || '';
  const requestId = params.get('requestId') || '';

  const [phase, setPhase] = useState<Phase>('confirm');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const newFrostMultisigKey = useStore(s => s.keyRing.newFrostMultisigKey);
  const getMultisigSecrets = useStore(s => s.keyRing.getMultisigSecrets);
  const keyInfos = useStore(s => s.keyRing.keyInfos);
  // find active multisig vault for signing
  const multisigVault = keyInfos.find(k => k.type === 'frost-multisig');

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
      } else if (action === 'frost-sign') {
        await runSign();
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

  const runDkgCreate = async () => {
    const abort = new AbortController();
    const relay = new FrostRelayClient(relayUrl);

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

    void relay.joinRoom(room.roomCode, pid, (event) => {
      if (event.type === 'message') {
        const text = new TextDecoder().decode(event.message.payload);
        if (dkgPhase === 'round1') peerBroadcasts.push(text);
        else if (dkgPhase === 'round2') peerRound2.push(text);
      }
    }, abort.signal);

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
      keyPackage: round3.key_package,
      publicKeyPackage: round3.public_key_package,
      ephemeralSeed: round3.ephemeral_seed,
      threshold,
      maxSigners,
      relayUrl,
    });

    abort.abort();
    const res = { success: true, address: addr, roomCode: room.roomCode, publicKeyPackage: round3.public_key_package };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  const runDkgJoin = async () => {
    const abort = new AbortController();
    const relay = new FrostRelayClient(relayUrl);

    setStatus(`joining room ${roomCode}...`);

    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    const peerBroadcasts: string[] = [];
    const peerRound2: string[] = [];
    let dkgPhase: 'round1' | 'round2' | 'done' = 'round1';
    let parsedThreshold = threshold;
    let parsedMaxSigners = maxSigners;

    void relay.joinRoom(roomCode, pid, (event) => {
      if (event.type === 'message') {
        const text = new TextDecoder().decode(event.message.payload);
        // coordinator's first message has DKG params prefix
        const match = text.match(/^DKG:(\d+):(\d+):([\s\S]*)$/);
        if (match) {
          parsedThreshold = Number(match[1]);
          parsedMaxSigners = Number(match[2]);
          if (dkgPhase === 'round1') peerBroadcasts.push(match[3]!);
        } else if (dkgPhase === 'round1') {
          peerBroadcasts.push(text);
        } else if (dkgPhase === 'round2') {
          peerRound2.push(text);
        }
      }
    }, abort.signal);

    setStatus('round 1 - collecting commitments...');
    // wait for at least one message to learn params
    await waitFor(() => peerBroadcasts.length >= 1, 120_000);

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
      keyPackage: round3.key_package,
      publicKeyPackage: round3.public_key_package,
      ephemeralSeed: round3.ephemeral_seed,
      threshold: parsedThreshold,
      maxSigners: parsedMaxSigners,
      relayUrl,
    });

    abort.abort();
    const res = { success: true, address: addr, roomCode };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  const runSign = async () => {
    if (!multisigVault) throw new Error('no multisig wallet found');

    const abort = new AbortController();
    const relay = new FrostRelayClient(relayUrl);
    const secrets = await getMultisigSecrets(multisigVault.id);
    if (!secrets) throw new Error('failed to decrypt multisig secrets');

    setStatus('joining signing session...');

    const pid = new Uint8Array(32);
    crypto.getRandomValues(pid);

    // parse alphas from coordinator message or use sighash as single alpha
    const alphas = [sighashHex];

    const peerCommitments: string[] = [];
    const peerShares: string[] = [];
    let sigPhase: 'commitments' | 'shares' = 'commitments';

    // join room BEFORE sending to avoid race condition
    void relay.joinRoom(roomCode, pid, (event) => {
      if (event.type === 'message') {
        const text = new TextDecoder().decode(event.message.payload);
        if (text.startsWith('C:') && sigPhase === 'commitments') {
          peerCommitments.push(text.slice(2));
        } else if (text.startsWith('S:')) {
          peerShares.push(text.slice(2));
        }
      }
    }, abort.signal);

    setStatus('generating commitments...');
    const round1 = await frostSignRound1InWorker(secrets.ephemeralSeed, secrets.keyPackage);

    // send commitments after joining
    await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`C:${round1.commitments}`));

    // use wallet's stored threshold, not attacker-controlled URL param
    const walletThreshold = (multisigVault.insensitive?.['threshold'] as number) || threshold;
    setStatus('waiting for other signers...');
    await waitFor(() => peerCommitments.length >= walletThreshold - 1, 120_000);

    sigPhase = 'shares';
    setStatus('signing...');

    const allCommitments = [round1.commitments, ...peerCommitments];
    for (const alpha of alphas) {
      const share = await frostSpendSignInWorker(
        secrets.keyPackage, round1.nonces, sighashHex, alpha, allCommitments,
      );
      await relay.sendMessage(roomCode, pid, new TextEncoder().encode(`S:${share}`));
    }

    abort.abort();
    const res = { success: true, signed: true };
    setResult(res);
    setPhase('complete');
    sendResult(requestId, res);
  };

  const actionLabel = action === 'frost-create' ? 'Create Multisig'
    : action === 'frost-join' ? 'Join Multisig'
    : action === 'frost-sign' ? 'Sign Transaction'
    : action;

  return (
    <div className='flex flex-col h-full p-4 gap-4'>
      <div className='text-center'>
        <span className='kicker'>frost multisig</span>
        <h2 className='mt-1 text-[18px] text-fg-high lowercase tracking-[-0.01em]'>{actionLabel}</h2>
        <p className='mt-1 text-[10px] text-fg-dim lowercase tracking-[0.04em]'>requested by {app}</p>
      </div>

      {phase === 'confirm' && (
        <div className='flex flex-col gap-4 flex-1'>
          <div className='rounded-md border border-border-soft bg-elev-1 p-3 text-xs space-y-2 text-fg'>
            {action === 'frost-create' && (
              <>
                <p>Create a <span className='tabular text-zigner-gold'>{threshold}-of-{maxSigners}</span> FROST multisig wallet.</p>
                <p className='text-fg-muted'>This generates a shared key via distributed key generation. All participants must be online.</p>
              </>
            )}
            {action === 'frost-join' && (
              <>
                <p>Join FROST DKG room: <span className='tabular text-zigner-gold'>{roomCode}</span></p>
                <p className='text-fg-muted'>You will participate in key generation to create a shared multisig wallet.</p>
              </>
            )}
            {action === 'frost-sign' && (
              <>
                <p>Co-sign a transaction with your FROST key share.</p>
                <p className='text-fg-muted tabular break-all'>sighash: {sighashHex.slice(0, 16)}...{sighashHex.slice(-16)}</p>
              </>
            )}
            <p className='text-fg-dim tabular'>relay: {relayUrl}</p>
          </div>

          <div className='flex gap-2 mt-auto'>
            <Button variant='secondary' className='flex-1' onClick={deny}>deny</Button>
            <Button className='flex-1' onClick={approve}>approve</Button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className='flex flex-col items-center gap-3 flex-1 justify-center'>
          <span className='i-lucide-loader-2 size-8 animate-spin text-zigner-gold' />
          <p className='text-[13px] text-fg text-center lowercase tracking-[0.02em]'>{status}</p>
        </div>
      )}

      {phase === 'complete' && (
        <div className='flex flex-col items-center gap-3 flex-1 justify-center'>
          <span className='i-lucide-check-circle size-10 text-green-400' />
          <p className='text-[13px] text-fg-high lowercase tracking-[0.02em]'>done</p>
          {typeof result?.['address'] === 'string' && (
            <p className='text-xs tabular text-fg-muted break-all px-4'>
              {result['address'].slice(0, 20)}...
            </p>
          )}
          <Button variant='secondary' onClick={() => window.close()}>close</Button>
        </div>
      )}

      {phase === 'error' && (
        <div className='flex flex-col items-center gap-3 flex-1 justify-center'>
          <span className='i-lucide-x-circle size-10 text-red-400' />
          <p className='text-[13px] text-red-400 text-center'>{error}</p>
          <Button variant='secondary' onClick={() => window.close()}>close</Button>
        </div>
      )}
    </div>
  );
};
