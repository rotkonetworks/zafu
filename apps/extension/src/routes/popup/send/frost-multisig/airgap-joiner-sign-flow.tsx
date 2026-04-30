// airgap (zigner-mediated) FROST multisig — JOINER side. zafu has no FROST
// share locally; joins an existing relay room, awaits the host's SIGN: tx
// context, then mediates QR round-trips with zigner to publish C: + S: shares.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { AnimatedQrDisplay } from '../../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../../shared/components/animated-qr-scanner';
import {
  openJoinerSession,
  sendCommitments,
  sendShare,
  type RelaySession,
} from './relay-protocol';
import { waitFor, DontQuitIcon, SignStepProgress } from './helpers';

export interface JoinerMultisig {
  publicKeyPackage: string;
  threshold: number;
  maxSigners: number;
  relayUrl?: string;
  /** zigner-side wallet_id for O(1) lookup; falls back to publicKeyPackage scan if absent. */
  zignerWalletId?: string;
}

interface Props {
  ms: JoinerMultisig;
  roomCode: string;
  walletLabel: string;
  walletAddress: string;
  onComplete: () => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

type Step = 'awaiting-sign' | 'review' | 'r1-out' | 'r1-in' | 'r1-relay'
  | 'r2-out' | 'r2-in' | 'r2-relay';

export function FrostAirgapJoinerSignFlow({
  ms, roomCode, walletLabel, walletAddress, onComplete, onCancel, onError,
}: Props) {
  const [step, setStep] = useState<Step>('awaiting-sign');
  const [trigger1, setTrigger1] = useState<Uint8Array | null>(null);
  const [trigger2, setTrigger2] = useState<Uint8Array | null>(null);
  const [peersReady, setPeersReady] = useState(0);
  const [tx, setTx] = useState<{ sighash: string; alphas: string[]; recipient: string; amountZat: string; feeZat: string } | null>(null);
  const sessionRef = useRef<RelaySession | null>(null);
  const zignerCommitsRef = useRef<string[] | null>(null);
  // raw peer C: payloads — split per-action only after numActions is known.
  // joiner doesn't aggregate, so peer S: shares are intentionally not buffered.
  const peerCommitsRawRef = useRef<string[]>([]);

  // single subscription for the whole flow. handler latches SIGN:, accumulates
  // raw C:/S: payloads; per-action bucketing happens after numActions is known.
  useEffect(() => {
    let signSeen = false;
    try {
      const s = openJoinerSession(ms.relayUrl || 'https://poker.zk.bot', roomCode);
      sessionRef.current = s;
      void s.relay.joinRoom(s.roomCode, s.participantId, (event) => {
        if (event.type !== 'message') return;
        const text = new TextDecoder().decode(event.message.payload);
        const sg = text.match(/^SIGN:([0-9a-fA-F]+):([^:]+):([^:]+):(\d+):(\d+)$/);
        if (sg && !signSeen) {
          signSeen = true;
          setTx({
            sighash: sg[1]!, alphas: sg[2]!.split(','),
            recipient: sg[3]!, amountZat: sg[4]!, feeZat: sg[5]!,
          });
          setStep((cur) => cur === 'awaiting-sign' ? 'review' : cur);
          return;
        }
        const cm = text.match(/^C:([\s\S]*)$/);
        if (cm) {
          peerCommitsRawRef.current.push(cm[1]!);
          setPeersReady(peerCommitsRawRef.current.length);
          return;
        }
        // S: peer shares — joiner ignores; only the host aggregates.
      }, s.abort.signal);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'failed to join room');
    }
    return () => {
      sessionRef.current?.abort.abort();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = () => {
    const s = sessionRef.current;
    if (!s) throw new Error('relay session lost');
    return s;
  };

  // user approved review → build trigger1 and show to zigner.
  const approve = () => {
    if (!tx) return;
    const trigger = JSON.stringify({
      frost: 'sign1',
      publicKeyPackage: ms.publicKeyPackage,
      ...(ms.zignerWalletId ? { walletId: ms.zignerWalletId } : {}),
      sighash: tx.sighash,
      alphas: tx.alphas,
      summary: {
        recipient: tx.recipient, amountZat: tx.amountZat, feeZat: tx.feeZat,
        threshold: ms.threshold, maxSigners: ms.maxSigners, roomCode,
      },
    });
    setTrigger1(new TextEncoder().encode(trigger));
    setStep('r1-out');
  };

  // zigner returned commitments → publish on existing session, wait for peer
  // C: bundles, then bundle per-action and build trigger2.
  const handleR1Response = async (raw: string) => {
    try {
      if (!tx) throw new Error('no tx context');
      const json = JSON.parse(raw);
      if (json.frost !== 'sign1-resp' || !Array.isArray(json.commitments)) {
        throw new Error('unexpected zigner response — expected sign1-resp');
      }
      zignerCommitsRef.current = json.commitments as string[];
      setStep('r1-relay');

      const s = session();
      await sendCommitments(s, zignerCommitsRef.current!);

      // wait for threshold-1 peer commitment bundles (host + any other joiners).
      await waitFor(() => peerCommitsRawRef.current.length >= ms.threshold - 1, 300_000);

      // split each peer's "c0|c1|..." into per-action lists.
      const numActions = tx.alphas.length;
      const peerPerAction: string[][] = Array.from({ length: numActions }, () => []);
      for (const raw of peerCommitsRawRef.current) {
        const parts = raw.split('|');
        for (let i = 0; i < numActions && i < parts.length; i++) {
          peerPerAction[i]!.push(parts[i]!);
        }
      }
      const bundled = Array.from({ length: numActions }, (_, i) => [
        zignerCommitsRef.current![i]!,
        ...peerPerAction[i]!,
      ]);

      const trigger = JSON.stringify({
        frost: 'sign2',
        publicKeyPackage: ms.publicKeyPackage,
        ...(ms.zignerWalletId ? { walletId: ms.zignerWalletId } : {}),
        sighash: tx.sighash,
        alphas: tx.alphas,
        bundledCommitments: bundled,
      });
      setTrigger2(new TextEncoder().encode(trigger));
      setStep('r2-out');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'round 1 failed');
    }
  };

  // zigner returned shares → publish each via S:i:share, hand off to wrapper.
  const handleR2Response = async (raw: string) => {
    try {
      if (!tx) throw new Error('no tx context');
      const json = JSON.parse(raw);
      if (json.frost !== 'sign2-resp' || !Array.isArray(json.shares)) {
        throw new Error('unexpected zigner response — expected sign2-resp');
      }
      const shares = json.shares as string[];
      setStep('r2-relay');

      const s = session();
      for (let i = 0; i < tx.alphas.length; i++) {
        await sendShare(s, i, shares[i]!);
      }
      s.abort.abort();
      sessionRef.current = null;
      onComplete();
    } catch (err) {
      sessionRef.current?.abort.abort();
      sessionRef.current = null;
      onError(err instanceof Error ? err.message : 'round 2 failed');
    }
  };

  const cancel = () => {
    sessionRef.current?.abort.abort();
    sessionRef.current = null;
    onCancel();
  };

  const Header = ({ onBack }: { onBack?: () => void }) => (
    <div className="flex items-center gap-3 w-full">
      {onBack && (
        <button onClick={onBack} className="text-fg-muted hover:text-fg-high transition-colors">
          <span className="i-lucide-arrow-left h-5 w-5" />
        </button>
      )}
      <h2 className="text-base font-medium flex-1">co-sign multisig</h2>
      <DontQuitIcon />
    </div>
  );

  const formatZec = (zat: string) =>
    !zat ? '0' : (Number(zat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

  switch (step) {
    case 'awaiting-sign':
      return (
        <div className="flex flex-col items-center gap-4 p-6">
          <Header onBack={cancel} />
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="i-lucide-loader-2 size-3.5 animate-spin" />
            waiting for transaction from coordinator…
          </div>
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1 text-center">
            host publishes a SIGN: payload (sighash + alphas + recipient/amount) on the relay; we review and authorize before triggering zigner.
          </p>
        </div>
      );

    case 'review':
      return (
        <div className="flex flex-col gap-3 p-4">
          <Header onBack={cancel} />
          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3">
            <p className="text-[10px] uppercase tracking-wider text-yellow-400">review transaction</p>
          </div>
          <div className="rounded-lg border border-border-soft bg-elev-1 p-3 flex flex-col gap-2.5">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-fg-muted">from</p>
              <p className="mt-0.5 text-xs font-medium">{walletLabel}</p>
              <p className="mt-0.5 break-all font-mono text-[10px] text-fg-muted">{walletAddress}</p>
            </div>
            <div className="border-t border-border-soft" />
            <div>
              <p className="text-[10px] uppercase tracking-wider text-fg-muted">to</p>
              <p className="mt-0.5 break-all font-mono text-[10px]">{tx?.recipient}</p>
            </div>
            <div className="border-t border-border-soft" />
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">amount</span>
              <span className="text-sm font-medium">{formatZec(tx?.amountZat ?? '')} ZEC</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">fee</span>
              <span className="text-xs text-fg-muted">{formatZec(tx?.feeZat ?? '')} ZEC</span>
            </div>
          </div>
          <p className="text-[10px] text-fg-muted">
            approving triggers zigner to sign with this wallet's share. coordinator aggregates and broadcasts.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={cancel}>reject</Button>
            <Button variant="gradient" onClick={approve}>approve & sign</Button>
          </div>
        </div>
      );

    case 'r1-out':
      return (
        <div className="flex flex-col items-center gap-3 p-4">
          <Header onBack={cancel} />
          <SignStepProgress current={1} />
          <p className="text-sm text-fg-high">show this QR to zigner</p>
          {trigger1 && <AnimatedQrDisplay data={trigger1} urType="zafu-frost-sign" size={220} />}
          <Button variant="gradient" onClick={() => setStep('r1-in')} className="w-full">
            scan qr from zigner
          </Button>
          <Button variant="secondary" onClick={cancel} className="w-full">cancel</Button>
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1">
            sighash + per-action alphas. zigner generates fresh round-1 nonces locally and shows commitments back.
          </p>
        </div>
      );

    case 'r1-in':
      return (
        <div className="flex flex-col items-center gap-3 p-4">
          <Header onBack={() => setStep('r1-out')} />
          <SignStepProgress current={1} />
          <p className="text-sm text-fg-high">scan zigner's commitments QR</p>
          <AnimatedQrScanner
            inline
            title="scan zigner round-1 commitments"
            onComplete={(data) => void handleR1Response(new TextDecoder().decode(data))}
            onClose={() => setStep('r1-out')}
          />
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1">
            public part of zigner's nonces. zafu publishes them to the relay so co-signers can compute the same challenge.
          </p>
        </div>
      );

    case 'r1-relay':
      return (
        <div className="flex flex-col items-center gap-4 p-6">
          <Header />
          <SignStepProgress current={1} />
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="i-lucide-loader-2 size-3.5 animate-spin" />
            exchanging commitments...
          </div>
          <div className="flex items-center gap-2 rounded-md bg-elev-2 px-3 py-1.5">
            <span className="i-lucide-users size-3.5 text-fg-muted" />
            <span className="text-xs">
              <span className="font-medium text-fg">{peersReady + 1}</span>
              <span className="text-fg-muted"> / {ms.threshold} ready</span>
            </span>
          </div>
          <Button variant="secondary" onClick={cancel} className="w-full mt-2">cancel</Button>
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1 text-center">
            zigner's commitments are on the relay. waiting on peer commitment bundle(s).
          </p>
        </div>
      );

    case 'r2-out':
      return (
        <div className="flex flex-col items-center gap-3 p-4">
          <Header onBack={cancel} />
          <SignStepProgress current={2} />
          <p className="text-sm text-fg-high">show this QR to zigner</p>
          {trigger2 && <AnimatedQrDisplay data={trigger2} urType="zafu-frost-sign" size={220} />}
          <Button variant="gradient" onClick={() => setStep('r2-in')} className="w-full">
            scan qr from zigner
          </Button>
          <Button variant="secondary" onClick={cancel} className="w-full">cancel</Button>
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1">
            all co-signers' round-1 commitments grouped per action. zigner derives ρ and computes its share.
          </p>
        </div>
      );

    case 'r2-in':
      return (
        <div className="flex flex-col items-center gap-3 p-4">
          <Header onBack={() => setStep('r2-out')} />
          <SignStepProgress current={2} />
          <p className="text-sm text-fg-high">scan zigner's shares QR</p>
          <AnimatedQrScanner
            inline
            title="scan zigner round-2 shares"
            onComplete={(data) => void handleR2Response(new TextDecoder().decode(data))}
            onClose={() => setStep('r2-out')}
          />
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1">
            zafu publishes each share to the relay. coordinator aggregates and broadcasts.
          </p>
        </div>
      );

    case 'r2-relay':
      return (
        <div className="flex flex-col items-center gap-4 p-6">
          <Header />
          <SignStepProgress current={3} />
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="i-lucide-loader-2 size-3.5 animate-spin" />
            publishing shares...
          </div>
        </div>
      );
  }
}
