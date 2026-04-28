/**
 * QR-mediated FROST DKG joiner flow for zigner-imported wallets.
 *
 * Mirrors zigner-create.tsx but bootstraps T/N/sk from the host's
 * R1 broadcast (parsed off the relay) rather than from a config form.
 *
 * Slice 2: scaffolding only. Relay calls and FROST WASM are stubbed
 * with TODO markers; slices 3+ plug in the real I/O.
 */

import { useState } from 'react';
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

  // bootstrap from host's R1 — slice 3 fills these from relay traffic
  const [threshold, setThreshold] = useState(0);
  const [maxSigners, setMaxSigners] = useState(0);
  // const [fvkSk, setFvkSk] = useState('');  // slice 3: parse off host R1

  const [peerR1] = useState<string[]>([]);
  const [peerR2] = useState<string[]>([]);
  const [zignerR1Bcast, setZignerR1Bcast] = useState('');
  const [, setZignerR2Pkgs] = useState<string[]>([]);
  const [publicKeyPackage, setPublicKeyPackage] = useState('');
  const [walletId, setWalletId] = useState('');

  const dkg1Trigger = JSON.stringify({
    frost: 'dkg1',
    t: threshold,
    n: maxSigners,
    label: `${threshold}-of-${maxSigners} multisig`,
    mainnet: true,
  });

  const dkg2Trigger = JSON.stringify({
    frost: 'dkg2',
    broadcasts: peerR1,
  });

  const dkg3Trigger = JSON.stringify({
    frost: 'dkg3',
    r1: [zignerR1Bcast, ...peerR1].filter(Boolean),
    r2: peerR2,
  });

  const onZignerR1 = (jsonText: string) => {
    try {
      const parsed = JSON.parse(jsonText) as { frost?: string; broadcast?: string };
      if (parsed.frost !== 'r1' || !parsed.broadcast) throw new Error('not an r1 ack');
      setZignerR1Bcast(parsed.broadcast);
      // TODO(slice-4): broadcast `R1:${parsed.broadcast}` to relay (joiner
      // does NOT prefix with T:N:SK — only the host carries that)
      setStep('waiting-r1');
    } catch (e) {
      setError(`r1 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  const onZignerR2 = (jsonText: string) => {
    try {
      const parsed = JSON.parse(jsonText) as { frost?: string; packages?: string[] };
      if (parsed.frost !== 'r2' || !Array.isArray(parsed.packages)) throw new Error('not an r2 ack');
      setZignerR2Pkgs(parsed.packages);
      // TODO(slice-4): for each pkg, send `R2:${pkg}` to relay
      setStep('waiting-r2');
    } catch (e) {
      setError(`r2 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  const onZignerR3 = (jsonText: string) => {
    try {
      const parsed = JSON.parse(jsonText) as {
        frost?: string;
        public_key_package?: string;
        wallet_id?: string;
      };
      if (parsed.frost !== 'r3' || !parsed.public_key_package || !parsed.wallet_id) {
        throw new Error('not an r3 ack');
      }
      setPublicKeyPackage(parsed.public_key_package);
      setWalletId(parsed.wallet_id);
      // TODO(slice-4): derive UFVK from public_key_package + sk (parsed
      // from host R1), echo-broadcast on relay, verify peers, save record.
      setStep('fvk-echo');
    } catch (e) {
      setError(`r3 scan: ${e instanceof Error ? e.message : String(e)}`);
      setStep('error');
    }
  };

  const handleJoin = () => {
    if (!roomCode.trim()) return;
    // TODO(slice-4): connect to relay, join room. State machine then
    // sits in waiting-host-r1 until the host's R1 prefix arrives.
    setStep('waiting-host-r1');
  };

  // dev-only stub: simulate host R1 arrival to advance the state machine
  // before slice-4 wires the real relay listener.
  const stubHostR1 = () => {
    setThreshold(2);
    setMaxSigners(3);
    setStep('dkg1-show');
  };

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
            onClick={handleJoin}
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
          <p className='text-[10px] text-fg-muted text-center'>
            TODO(slice-4): parse T:N:SK from host R1
          </p>
          <button
            className='rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-zigner-gold'
            onClick={stubHostR1}
          >
            (dev) skip → fake 2-of-3 host
          </button>
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
        <ScanZignerJson
          title='scan zigner round-1 broadcast'
          onScan={onZignerR1}
          onCancel={() => setStep('dkg1-show')}
        />
      )}

      {step === 'waiting-r1' && (
        <WaitingForRelay
          headline='round 1 sent'
          body={`waiting for ${maxSigners - 1} peer R1 broadcast(s)…`}
          onSkip={() => setStep('dkg2-show')}
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
        <ScanZignerJson
          title='scan zigner round-2 packages'
          onScan={onZignerR2}
          onCancel={() => setStep('dkg2-show')}
        />
      )}

      {step === 'waiting-r2' && (
        <WaitingForRelay
          headline='round 2 sent'
          body={`waiting for ${(maxSigners - 1) ** 2} peer R2 package(s)…`}
          onSkip={() => setStep('dkg3-show')}
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
        <ScanZignerJson
          title='scan zigner r3 ack (public_key_package)'
          onScan={onZignerR3}
          onCancel={() => setStep('dkg3-show')}
        />
      )}

      {step === 'fvk-echo' && (
        <div className='flex flex-col gap-3 text-xs text-fg-muted'>
          <p>TODO(slice-4): derive UFVK + address, echo on relay, verify peers, save wallet.</p>
          <p className='font-mono break-all text-[10px]'>
            wallet_id: {walletId}<br />
            pkg: {publicKeyPackage.slice(0, 32)}…
          </p>
          <button
            className='rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-zigner-gold'
            onClick={() => setStep('complete')}
          >
            (dev) skip echo → complete
          </button>
        </div>
      )}

      {step === 'complete' && (
        <div className='rounded-lg border border-green-500/40 bg-green-500/5 p-3 text-xs text-green-400'>
          multisig wallet saved (custody: zigner)
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
  onScan: (jsonText: string) => void;
  onCancel: () => void;
}

const ScanZignerJson = ({ title, onScan, onCancel }: ScanProps) => (
  <QrScanner
    title={title}
    onScan={raw => {
      const looksHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
      const text = looksHex
        ? new TextDecoder().decode(
            Uint8Array.from(raw.match(/.{2}/g) ?? [], h => parseInt(h, 16)),
          )
        : raw;
      onScan(text);
    }}
    onClose={onCancel}
    inline
  />
);

const WaitingForRelay = ({ headline, body, onSkip }: { headline: string; body: string; onSkip: () => void }) => (
  <div className='flex flex-col items-center gap-3'>
    <p className='text-xs text-fg-muted'>{headline}</p>
    <p className='text-[10px] text-fg-muted text-center'>{body}</p>
    <span className='i-lucide-loader-2 size-4 animate-spin text-fg-muted' />
    <button
      className='rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-zigner-gold'
      onClick={onSkip}
    >
      (dev) skip
    </button>
  </div>
);
