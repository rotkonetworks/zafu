// airgap (zigner-mediated) FROST multisig sign flow. zafu builds the unsigned
// tx, hands sighash + alphas to zigner via QR, mediates relay traffic with
// peers, then aggregates + broadcasts. zigner does all FROST math.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { AnimatedQrDisplay } from '../../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../../shared/components/animated-qr-scanner';
import {
  frostSpendAggregateInWorker,
  type SendTxUnsignedResult,
} from '../../../../state/keyring/network-worker';
import {
  openRelayRoom,
  subscribePeers,
  sendSignPrefix,
  sendCommitments,
  sendShare,
  type RelaySession,
} from './relay-protocol';
import { waitFor, DontQuitIcon, RoomCodeChip, SignStepProgress } from './helpers';

export interface AirgapMultisig {
  publicKeyPackage: string;
  threshold: number;
  maxSigners: number;
  relayUrl?: string;
}

interface Props {
  ms: AirgapMultisig;
  unsigned: SendTxUnsignedResult;
  recipient: string;
  amount: string;
  fee: string;
  /** caller broadcasts the tx with these orchard sigs; receives txid. */
  onComplete: (orchardSigs: string[]) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string) => void;
}

type Step = 'r1-out' | 'r1-in' | 'r1-relay' | 'r2-out' | 'r2-in' | 'r2-relay';

export function FrostAirgapSignFlow({ ms, unsigned, recipient, amount, fee, onComplete, onCancel, onError }: Props) {
  const [step, setStep] = useState<Step>('r1-out');
  const [trigger1, setTrigger1] = useState<Uint8Array | null>(null);
  const [trigger2, setTrigger2] = useState<Uint8Array | null>(null);
  const [peersReady, setPeersReady] = useState(0);
  const [progress, setProgress] = useState('');
  const sessionRef = useRef<RelaySession | null>(null);
  const zignerCommitsRef = useRef<string[] | null>(null);
  const peerBucketsRef = useRef<{ peerCommits: string[][]; peerShares: string[][] } | null>(null);

  const numActions = unsigned.alphas.length;
  const amountZat = Math.round(Number(amount) * 1e8).toString();

  // open relay + build trigger-1 on mount; tear down on unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await openRelayRoom(
          ms.relayUrl || 'https://poker.zk.bot',
          ms.threshold,
          ms.maxSigners,
          600,
        );
        if (cancelled) { session.abort.abort(); return; }
        sessionRef.current = session;
        const trigger = JSON.stringify({
          frost: 'sign1',
          publicKeyPackage: ms.publicKeyPackage,
          sighash: unsigned.sighash,
          alphas: unsigned.alphas,
          summary: {
            recipient, amountZat, feeZat: unsigned.fee,
            threshold: ms.threshold, maxSigners: ms.maxSigners,
            roomCode: session.roomCode, relayUrl: ms.relayUrl,
          },
        });
        setTrigger1(new TextEncoder().encode(trigger));
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'failed to open relay room');
      }
    })();
    return () => {
      cancelled = true;
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

  // step 2 → 3: zigner returned commitments. publish, wait for peers, build trigger-2.
  const handleR1Response = async (raw: string) => {
    try {
      const json = JSON.parse(raw);
      if (json.frost !== 'sign1-resp' || !Array.isArray(json.commitments)) {
        throw new Error('unexpected zigner response — expected sign1-resp');
      }
      zignerCommitsRef.current = json.commitments as string[];
      setStep('r1-relay');

      const s = session();
      const buckets = subscribePeers(s, numActions, setPeersReady);
      peerBucketsRef.current = buckets;

      await sendSignPrefix(s, unsigned.sighash, unsigned.alphas, recipient, amountZat, unsigned.fee);
      await sendCommitments(s, zignerCommitsRef.current!);

      await waitFor(() => buckets.peerCommits[0]!.length >= ms.threshold - 1, 300_000);

      // bundle per-action: zigner's own commitment first, then peers'
      const bundled = Array.from({ length: numActions }, (_, i) => [
        zignerCommitsRef.current![i]!,
        ...buckets.peerCommits[i]!,
      ]);
      const trigger = JSON.stringify({
        frost: 'sign2',
        publicKeyPackage: ms.publicKeyPackage,
        sighash: unsigned.sighash,
        alphas: unsigned.alphas,
        bundledCommitments: bundled,
      });
      setTrigger2(new TextEncoder().encode(trigger));
      setStep('r2-out');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'round 1 failed');
    }
  };

  // step 4 → done: zigner returned shares. publish, wait, aggregate, hand to caller.
  const handleR2Response = async (raw: string) => {
    try {
      const json = JSON.parse(raw);
      if (json.frost !== 'sign2-resp' || !Array.isArray(json.shares)) {
        throw new Error('unexpected zigner response — expected sign2-resp');
      }
      const zignerShares = json.shares as string[];
      setStep('r2-relay');

      const s = session();
      const { peerCommits, peerShares } = peerBucketsRef.current!;
      const orchardSigs: string[] = [];
      for (let i = 0; i < numActions; i++) {
        await sendShare(s, i, zignerShares[i]!);
        setProgress(`collecting peer shares (${i + 1}/${numActions})…`);
        await waitFor(() => peerShares[i]!.length >= ms.threshold - 1, 300_000);

        const allCommits = [zignerCommitsRef.current![i]!, ...peerCommits[i]!];
        const allShares = [zignerShares[i]!, ...peerShares[i]!];
        const sig = await frostSpendAggregateInWorker(
          ms.publicKeyPackage, unsigned.sighash, unsigned.alphas[i]!, allCommits, allShares,
        );
        orchardSigs.push(sig);
      }
      s.abort.abort();
      sessionRef.current = null;

      await onComplete(orchardSigs);
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
      <h2 className="text-base font-medium flex-1">multisig sign</h2>
      <DontQuitIcon />
    </div>
  );

  switch (step) {
    case 'r1-out':
      return (
        <div className="flex flex-col items-center gap-3 p-4">
          <Header onBack={cancel} />
          <SignStepProgress current={1} />
          <p className="text-sm text-fg-high">show this QR to zigner</p>
          {trigger1 && <AnimatedQrDisplay data={trigger1} urType="zafu-frost-sign" size={220} />}
          {sessionRef.current && <RoomCodeChip code={sessionRef.current.roomCode} />}
          <div className="w-full rounded bg-elev-2 p-2 text-[11px] text-fg-muted space-y-0.5">
            <p>{ms.threshold}-of-{ms.maxSigners} threshold</p>
            <p>send {amount} ZEC to {recipient.slice(0, 16)}…{recipient.slice(-8)}</p>
            <p>fee: {fee} ZEC</p>
          </div>
          <Button variant="gradient" onClick={() => setStep('r1-in')} className="w-full">
            zigner has scanned — show me its response
          </Button>
          <Button variant="secondary" onClick={cancel} className="w-full">cancel</Button>
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1">
            sighash + per-action alphas + room code. zigner generates fresh round-1 nonces locally and shows commitments back.
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
            public part of zigner's nonces. zafu publishes to the relay so co-signers compute the same challenge — no secret leaves zigner.
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
          {sessionRef.current && <RoomCodeChip code={sessionRef.current.roomCode} />}
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
            zigner has scanned — show me its share
          </Button>
          <Button variant="secondary" onClick={cancel} className="w-full">cancel</Button>
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1">
            all co-signers' round-1 commitments grouped per action. zigner derives ρ and computes its share — nonces stay on zigner.
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
            one share per action. zafu collects peer shares, aggregates into orchard signatures, then broadcasts.
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
            {progress || 'finalizing...'}
          </div>
          {sessionRef.current && <RoomCodeChip code={sessionRef.current.roomCode} />}
          <p className="text-[10px] text-fg-muted/70 leading-snug pt-1 text-center">
            publishing shares, waiting on peer shares, aggregating signatures, broadcasting tx.
          </p>
        </div>
      );
  }
}
