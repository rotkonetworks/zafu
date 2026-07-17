/**
 * NU6.3 turnstile migration flow: orchard -> ironwood.
 *
 * One V6 transaction spends the wallet's full orchard balance to its OWN
 * ironwood address (derived from the UFVK inside the wasm - no recipient
 * input). Reuses the existing PCZT cold-sign machine end to end:
 * build -> CBOR-wrap -> animated UR frames -> zigner signs -> scan signed
 * PCZT -> extract -> broadcast.
 *
 * Feature-flagged: only reachable when IRONWOOD_MIGRATION is ON (see
 * config/feature-flags.ts). UX template = Zashi's proposeShielding prompt -
 * a banner on the zcash home surface whenever orchard balance > 0.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { AnimatedQrDisplay } from '../../../shared/components/animated-qr-display';
import { AnimatedQrScanner } from '../../../shared/components/animated-qr-scanner';
import {
  buildTurnstileMigrationInWorker,
  completeTurnstileMigrationInWorker,
  spawnNetworkWorker,
  type TurnstileMigrationUnsignedResult,
} from '../../../state/keyring/network-worker';
import {
  parsePreludeSinglePcztResponse,
  unwrapCborSinglePczt,
  ZIGNER_PCZT_SIGNED_UR_TYPE,
} from './zcash-send-cbor-helpers';

const fmtZec = (zat: bigint): string =>
  (Number(zat) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

/** shape of the wasm PcztSummary the ironwood-aware signer confirms */
interface PcztSummary {
  orchard_actions: number;
  ironwood_actions: number;
  transparent_inputs: number;
  /** [label, zatoshis] pairs; label e.g. `ironwood:<43-byte-hex>` / `ironwood:shielded` */
  outputs: [string, number][];
  fee_zat?: number | null;
}

/**
 * Pull the ironwood migration destination + amount + fee from the PcztSummary
 * the cold signer will actually confirm (FIX-C item 3). Driving the review off
 * the summary - never off wallet-computed metadata that could disagree with
 * what gets signed - is the whole point: the destination and fee the user sees
 * are bound to the bytes the signer renders.
 */
function ironwoodDestinationFromSummary(summary: unknown): {
  destinationLabel: string | null;
  ironwoodZat: bigint | null;
  feeZat: bigint | null;
} {
  const s = summary as PcztSummary | null | undefined;
  if (!s || !Array.isArray(s.outputs)) {
    return { destinationLabel: null, ironwoodZat: null, feeZat: null };
  }
  let destinationLabel: string | null = null;
  let ironwoodZat: bigint | null = null;
  for (const entry of s.outputs) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const [label, value] = entry;
    if (typeof label === 'string' && label.startsWith('ironwood:')) {
      destinationLabel = label.slice('ironwood:'.length);
      ironwoodZat = (ironwoodZat ?? 0n) + BigInt(Math.trunc(Number(value) || 0));
    }
  }
  const feeZat =
    s.fee_zat === null || s.fee_zat === undefined ? null : BigInt(Math.trunc(Number(s.fee_zat)));
  return { destinationLabel, ironwoodZat, feeZat };
}

/** truncate a long hex/address for display: first 10 + last 8 with an ellipsis. */
const shortenDest = (dest: string): string =>
  dest.length > 22 ? `${dest.slice(0, 10)}...${dest.slice(-8)}` : dest;

/**
 * Home-screen prompt (Zashi proposeShielding style): shown when the wallet
 * holds orchard balance and the turnstile is available. The caller gates on
 * the IRONWOOD_MIGRATION feature flag.
 */
export function IronwoodMigrationBanner({
  orchardZat,
  onMigrate,
}: {
  orchardZat: bigint;
  onMigrate: () => void;
}) {
  return (
    <div className='rounded-lg border border-primary/40 bg-primary/10 p-3'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='i-lucide-arrow-right-left h-4 w-4 text-zigner-gold' />
          <span className='text-xs text-fg-high'>migrate to ironwood</span>
          <span className='text-xs font-medium tabular-nums text-fg-muted'>
            {fmtZec(orchardZat)} ZEC
          </span>
        </div>
        <button
          onClick={onMigrate}
          className='text-xs font-medium text-zigner-gold hover:text-primary/90 transition-colors'
        >
          migrate
        </button>
      </div>
      <p className='mt-1.5 text-label text-fg-muted leading-snug'>
        NU6.3 replaces the orchard pool with ironwood. move your orchard funds through the one-way
        turnstile to keep spending them - orchard-to-orchard sends are disabled after activation.
      </p>
    </div>
  );
}

type MigrateStep = 'review' | 'building' | 'sign' | 'scan' | 'broadcast' | 'complete' | 'error';

interface IronwoodMigrateProps {
  onClose: () => void;
  walletId: string;
  serverUrl: string;
  backend: 'zidecar' | 'lightwalletd';
  mainnet: boolean;
  accountIndex: number;
  /** UFVK for the PCZT cold-sign machine; absent = hot wallet (unsupported) */
  ufvk?: string;
  orchardZat: bigint;
}

/** Full-screen turnstile migration flow, reusing the send PCZT UI machine. */
export function IronwoodMigrate({
  onClose,
  walletId,
  serverUrl,
  backend,
  mainnet,
  accountIndex,
  ufvk,
  orchardZat,
}: IronwoodMigrateProps) {
  const [step, setStep] = useState<MigrateStep>('review');
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const unsignedRef = useRef<TurnstileMigrationUnsignedResult | null>(null);
  const [urFrames, setUrFrames] = useState<string[] | null>(null);
  const [progressSteps, setProgressSteps] = useState<
    { step: string; detail?: string; elapsedMs: number }[]
  >([]);

  // mirror the zcash-send build screen: live progress from the worker
  useEffect(() => {
    if (step !== 'building' && step !== 'broadcast') {
      return;
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        step: string;
        detail?: string;
        elapsedMs: number;
      };
      setProgressSteps(prev => [...prev, detail]);
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [step]);

  const handleBuild = useCallback(async () => {
    if (!ufvk) {
      setError(
        'turnstile migration currently requires a zigner (cold-sign) wallet - hot-wallet signing lands with the NU6.3 signer update',
      );
      setStep('error');
      return;
    }
    setStep('building');
    setError(null);
    setProgressSteps([]);
    try {
      await spawnNetworkWorker('zcash');
      const result = await buildTurnstileMigrationInWorker(
        'zcash',
        walletId,
        serverUrl,
        accountIndex,
        mainnet,
        ufvk,
        backend,
      );
      unsignedRef.current = result;
      setUrFrames(result.urFrames);
      setStep('sign');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to build migration transaction');
      setStep('error');
    }
  }, [ufvk, walletId, serverUrl, accountIndex, mainnet, backend]);

  const handleSignedScanned = useCallback(
    async (envelopeBytes: Uint8Array) => {
      setStep('broadcast');
      try {
        // FIX-C item 1: the device emits ur:zigner-module whose decoded payload
        // is a CBOR {1: bytes} wrap (rust/signer module_response_to_ur ->
        // encode_pczt_to_cbor) OF the ironwood-aware signer's prelude response
        // envelope ([0x53][0x04][0x03] || digest || len || signed_pczt). The
        // scanner hands us the raw ur_decode_frames payload = the CBOR wrap, so
        // strip the CBOR {1: bytes} first, THEN parse the inner prelude envelope.
        const responseEnvelope = unwrapCborSinglePczt(envelopeBytes);
        const { signedPczt } = parsePreludeSinglePcztResponse(responseEnvelope);
        let pcztHex = '';
        for (let i = 0; i < signedPczt.length; i++) {
          pcztHex += signedPczt[i]!.toString(16).padStart(2, '0');
        }
        const result = await completeTurnstileMigrationInWorker(
          'zcash',
          walletId,
          serverUrl,
          pcztHex,
        );
        unsignedRef.current = null;
        setTxid(result.txid);
        setStep('complete');
      } catch (err) {
        unsignedRef.current = null;
        setError(err instanceof Error ? err.message : 'failed to extract / broadcast migration');
        setStep('error');
      }
    },
    [walletId, serverUrl],
  );

  // FIX-C item 3: destination, migrated amount, and fee shown on review are
  // driven from the PcztSummary the signer will actually confirm - NOT from the
  // wallet-computed fee/amount fields, which could disagree with the signed
  // bytes. Fall back to the worker's numbers only if the summary is absent
  // (e.g. an older blob that predates the structured summary).
  const summaryView = unsignedRef.current
    ? ironwoodDestinationFromSummary(unsignedRef.current.summary)
    : { destinationLabel: null, ironwoodZat: null, feeZat: null };
  const fee = summaryView.feeZat ?? (unsignedRef.current ? BigInt(unsignedRef.current.fee) : null);
  const amount =
    summaryView.ironwoodZat ?? (unsignedRef.current ? BigInt(unsignedRef.current.amount) : null);
  const destinationLabel = summaryView.destinationLabel;

  const renderContent = () => {
    switch (step) {
      case 'review':
        return (
          <div className='flex flex-col gap-4 p-4'>
            <div className='flex items-center gap-3'>
              <button
                onClick={onClose}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left h-5 w-5' />
              </button>
              <h2 className='text-lg font-medium'>migrate to ironwood</h2>
            </div>

            <div className='bg-elev-1 border border-border-soft rounded-lg p-4 flex flex-col gap-3'>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>from</span>
                <span className='font-medium'>orchard pool</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>to</span>
                <span className='font-medium'>ironwood pool (your wallet)</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>available to migrate</span>
                <span className='font-medium tabular-nums'>{fmtZec(orchardZat)} ZEC</span>
              </div>
              <div className='border-t border-border-soft pt-2'>
                <p className='text-xs text-fg-muted leading-snug'>
                  this builds a single transaction spending all your orchard notes to your own
                  ironwood address. the exact fee (ZIP-317) is computed during the build and
                  deducted from the migrated amount. the turnstile is one-way - funds cannot move
                  back to orchard.
                </p>
              </div>
            </div>

            <div className='flex gap-2 mt-2'>
              <Button variant='secondary' onClick={onClose} className='flex-1'>
                not now
              </Button>
              <Button variant='gradient' onClick={() => void handleBuild()} className='flex-1'>
                sign with zafu zigner
              </Button>
            </div>
          </div>
        );

      case 'building':
        return (
          <div className='flex flex-col items-center gap-4 p-6'>
            <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center'>
              <div className='w-8 h-8 border-2 border-zigner-gold border-t-transparent rounded-full animate-spin' />
            </div>
            <h2 className='text-lg font-medium'>building migration</h2>
            {progressSteps.length > 0 ? (
              <div className='w-full max-w-sm flex flex-col gap-1'>
                {progressSteps.map((s, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 text-xs ${
                      i === progressSteps.length - 1 ? 'text-fg' : 'text-fg-muted'
                    }`}
                  >
                    <span className='font-mono w-12 text-right shrink-0'>
                      {(s.elapsedMs / 1000).toFixed(1)}s
                    </span>
                    <span>
                      {s.step}
                      {s.detail && <span className='text-fg-muted ml-1'>({s.detail})</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className='text-sm text-fg-muted text-center'>preparing...</p>
            )}
          </div>
        );

      case 'sign':
        return (
          <div className='flex flex-col gap-4 p-4'>
            <div className='flex items-center gap-2'>
              <button
                onClick={() => setStep('review')}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left w-5 h-5' />
              </button>
              <h2 className='text-lg font-medium'>sign migration with zafu zigner</h2>
            </div>

            {amount !== null && fee !== null && (
              <div className='rounded bg-elev-2 p-3 text-xs text-fg-muted flex flex-col gap-1'>
                <div className='flex justify-between'>
                  <span>migrate</span>
                  <span className='tabular-nums text-fg-high'>{fmtZec(amount)} ZEC</span>
                </div>
                <div className='flex justify-between'>
                  <span>network fee</span>
                  <span className='tabular-nums'>{fmtZec(fee)} ZEC</span>
                </div>
                <div className='flex justify-between'>
                  <span>ironwood destination</span>
                  <span className='font-mono text-fg-high'>
                    {destinationLabel ? shortenDest(destinationLabel) : 'your wallet'}
                  </span>
                </div>
                <p className='mt-1 text-label leading-snug'>
                  these values are read from the transaction the zigner will confirm.
                </p>
              </div>
            )}

            <div className='flex flex-col items-center gap-4 py-2'>
              {urFrames && urFrames.length > 0 && (
                <AnimatedQrDisplay
                  urFrames={urFrames}
                  totalBytes={unsignedRef.current?.cborBytes}
                  size={220}
                  frameInterval={200}
                  title='scan with zafu zigner'
                  description='hold zigner camera steady; multi-frame transfer'
                />
              )}
              <div className='text-center'>
                <p className='text-sm text-fg-muted'>1. open zafu zigner app on your phone</p>
                <p className='text-sm text-fg-muted'>2. scan this qr code</p>
                <p className='text-sm text-fg-muted'>
                  3. review the ironwood migration and approve
                </p>
              </div>
            </div>

            <Button variant='gradient' onClick={() => setStep('scan')} className='w-full'>
              scan signature from zafu zigner
            </Button>
          </div>
        );

      case 'scan':
        return (
          <AnimatedQrScanner
            onComplete={bytes => {
              void handleSignedScanned(bytes);
            }}
            onError={err => {
              setError(err);
              setStep('error');
            }}
            onClose={() => setStep('sign')}
            title='scan signed PCZT'
            description='hold camera steady on the animated QR'
            urTypeFilter={ZIGNER_PCZT_SIGNED_UR_TYPE}
          />
        );

      case 'broadcast':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center animate-pulse'>
              <div className='w-8 h-8 border-2 border-zigner-gold border-t-transparent rounded-full animate-spin' />
            </div>
            <h2 className='text-lg font-medium'>broadcasting migration</h2>
            <p className='text-sm text-fg-muted text-center'>
              sending your turnstile transaction to the zcash network...
            </p>
          </div>
        );

      case 'complete':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center'>
              <span className='i-lucide-check w-8 h-8 text-green-400' />
            </div>
            <h2 className='text-lg font-medium'>migration sent!</h2>
            <p className='text-sm text-fg-muted text-center'>
              your orchard balance is on its way to the ironwood pool. it will show up once the
              transaction confirms and the sync catches up.
            </p>
            {txid && <p className='font-mono text-xs text-fg-muted break-all'>{txid}</p>}
            <Button variant='gradient' onClick={onClose} className='w-full mt-4'>
              done
            </Button>
          </div>
        );

      case 'error':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center'>
              <span className='i-lucide-x w-8 h-8 text-red-400' />
            </div>
            <h2 className='text-lg font-medium'>migration failed</h2>
            <p className='text-sm text-red-400 text-center'>{error ?? 'an error occurred'}</p>
            <div className='flex gap-2 w-full mt-4'>
              <Button variant='secondary' onClick={onClose} className='flex-1'>
                close
              </Button>
              <Button variant='gradient' onClick={() => setStep('review')} className='flex-1'>
                try again
              </Button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return <div className='fixed inset-0 z-50 overflow-y-auto bg-canvas'>{renderContent()}</div>;
}
