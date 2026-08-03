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
 * A fail-closed pre-activation error (worker's activation guard) means NU6.3
 * has not activated at the endpoint yet - migration is simply not available
 * yet, not a failure. Detect it so the flow can render a calm "available when
 * NU6.3 activates" state instead of an alarming "migration failed" screen.
 * Matches the two guard messages emitted in workers/zcash-worker.ts.
 */
function isPreActivationError(message: string | null): boolean {
  if (!message) {
    return false;
  }
  const m = message.toLowerCase();
  return (
    m.includes('nu6.3 is not active') ||
    m.includes('until nu6.3 activates') ||
    m.includes('refusing to build turnstile migration')
  );
}

/**
 * Home-screen prompt (Zashi proposeShielding style): shown when the wallet
 * holds orchard balance and the turnstile is available. The caller gates on
 * the IRONWOOD_MIGRATION feature flag.
 *
 * Orchard is framed as a legacy, migrate-only pool: after NU6.3 activates,
 * orchard-to-orchard sends are disabled, so funds are moved one-way to your
 * own ironwood address to keep spending them normally. The funds are never at
 * risk - only the pool changes. When orchardZat is 0 the wallet is fully
 * migrated and the banner renders nothing (the parent also gates on
 * orchardZat > 0, but returning null keeps this component safe on its own).
 */
export function IronwoodMigrationBanner({
  orchardZat,
  onMigrate,
}: {
  orchardZat: bigint;
  onMigrate: () => void;
}) {
  // Fully migrated: nothing left in the legacy orchard pool - no prompt.
  if (orchardZat <= 0n) {
    return null;
  }
  return (
    <div className='rounded-lg border border-primary/40 bg-primary/10 p-3'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='i-lucide-arrow-right-left h-4 w-4 text-zigner-gold' />
          <span className='text-xs text-fg-high'>orchard is now legacy</span>
          <span className='text-xs font-medium tabular-nums text-fg-muted'>
            {fmtZec(orchardZat)} ZEC to migrate
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
        NU6.3 makes ironwood the active pool. your orchard funds are safe - move them one-way to
        your own ironwood address to keep spending normally. orchard-to-orchard sends are disabled
        after activation.
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
  /** UFVK for the PCZT cold-sign machine (cold/watch-only wallets) */
  ufvk?: string;
  orchardZat: bigint;
  /**
   * Hot (self-custody / mnemonic) wallet: the wasm signs the V6 tx in-worker
   * and broadcasts directly - no zigner QR round trip. When true, `getMnemonic`
   * MUST be provided.
   */
  isHotWallet?: boolean;
  /**
   * Fetch the decrypted seed phrase (behind the password gate) for the hot
   * path. Returns null if the user cancels auth. Only called for hot wallets,
   * only at build time; the returned seed is handed straight to the worker and
   * never retained in component state.
   */
  getMnemonic?: () => Promise<string | null>;
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
  isHotWallet,
  getMnemonic,
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
    // HOT (self-custody) wallet: the wasm builds + proves + SIGNS the V6 tx and
    // the worker broadcasts it directly. One worker call covers build -> sign ->
    // broadcast, so we stay on 'building' (which shows live worker progress)
    // and jump straight to 'complete' - no 'sign'/'scan' zigner steps.
    if (isHotWallet) {
      if (!getMnemonic) {
        setError('hot-wallet signing unavailable (missing key access)');
        setStep('error');
        return;
      }
      setError(null);
      setProgressSteps([]);
      // pull the seed behind the password gate BEFORE showing the building
      // screen; a cancelled/failed unlock returns to review without building.
      let seed: string | null;
      try {
        seed = await getMnemonic();
      } catch {
        setError('could not unlock wallet');
        setStep('error');
        return;
      }
      if (!seed) {
        // user cancelled the password prompt
        setStep('review');
        return;
      }
      setStep('building');
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
          seed,
        );
        // hot path resolves to { txid, fee } (tx already broadcast in-worker)
        if (!('txid' in result)) {
          throw new Error('hot migration did not return a txid');
        }
        setTxid(result.txid);
        setStep('complete');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to build migration transaction');
        setStep('error');
      }
      return;
    }

    // COLD (zigner / watch-only) wallet: build an UNSIGNED PCZT and hand off to
    // the zigner QR cold-sign machine (unchanged).
    if (!ufvk) {
      setError('turnstile migration requires a zigner (cold-sign) or self-custody wallet');
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
      // cold path resolves to the unsigned PCZT result (with UR frames)
      if ('txid' in result) {
        throw new Error('unexpected signed result on cold-sign path');
      }
      unsignedRef.current = result;
      setUrFrames(result.urFrames);
      setStep('sign');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to build migration transaction');
      setStep('error');
    }
  }, [isHotWallet, getMnemonic, ufvk, walletId, serverUrl, accountIndex, mainnet, backend]);

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
        // Fully migrated: the legacy orchard pool is empty. Nothing to migrate -
        // confirm rather than offer a 0 ZEC transaction. (The home banner also
        // hides at 0, but the flow may already be open when the balance drains.)
        if (orchardZat <= 0n) {
          return (
            <div className='flex h-full min-h-0 flex-col'>
              <div className='flex shrink-0 items-center gap-3 p-4'>
                <button
                  onClick={onClose}
                  className='text-fg-muted hover:text-fg-high transition-colors'
                >
                  <span className='i-lucide-arrow-left h-5 w-5' />
                </button>
                <h2 className='text-lg font-medium'>migrate to ironwood</h2>
              </div>
              <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center'>
                <div className='flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20'>
                  <span className='i-lucide-check h-8 w-8 text-green-400' />
                </div>
                <h2 className='text-lg font-medium'>fully migrated</h2>
                <p className='max-w-sm text-sm text-fg-muted leading-snug'>
                  your orchard balance is empty - everything has moved to ironwood. there is nothing
                  left to migrate.
                </p>
              </div>
              <div className='shrink-0 p-4'>
                <Button variant='gradient' onClick={onClose} className='w-full'>
                  done
                </Button>
              </div>
            </div>
          );
        }
        return (
          <div className='flex h-full min-h-0 flex-col'>
            <div className='flex shrink-0 items-center gap-3 p-4'>
              <button
                onClick={onClose}
                className='text-fg-muted hover:text-fg-high transition-colors'
              >
                <span className='i-lucide-arrow-left h-5 w-5' />
              </button>
              <h2 className='text-lg font-medium'>migrate to ironwood</h2>
            </div>

            <div className='flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4'>
              <div className='flex items-center justify-center gap-4 pt-2'>
                <div className='flex flex-col items-center gap-1'>
                  <span className='i-lucide-shield h-7 w-7 text-fg-muted' />
                  <span className='text-xs text-fg-muted'>orchard</span>
                </div>
                <span className='i-lucide-arrow-right h-5 w-5 text-zigner-gold' />
                <div className='flex flex-col items-center gap-1'>
                  <span className='i-lucide-shield-check h-7 w-7 text-fg-high' />
                  <span className='text-xs font-medium'>ironwood</span>
                </div>
              </div>

              <div className='text-center'>
                <div className='text-3xl font-semibold tabular-nums'>{fmtZec(orchardZat)}</div>
                <div className='text-sm text-fg-muted'>ZEC to migrate</div>
              </div>

              <p className='text-center text-xs text-fg-muted leading-snug'>
                orchard is now a legacy pool. this moves your full orchard balance to your own
                ironwood address so you can keep spending it normally.
              </p>

              <div className='divide-y divide-border-soft rounded-lg border border-border-soft bg-elev-1'>
                <div className='flex items-center justify-between px-4 py-3 text-sm'>
                  <span className='text-fg-muted'>destination</span>
                  <span className='font-medium'>your ironwood address</span>
                </div>
                <div className='flex items-center justify-between px-4 py-3 text-sm'>
                  <span className='text-fg-muted'>network fee</span>
                  <span className='text-fg-muted'>computed at build</span>
                </div>
              </div>

              <div className='flex items-center gap-2 text-xs text-fg-muted'>
                <span className='i-lucide-arrow-right h-4 w-4 shrink-0' />
                <span>one-way - your funds stay yours, they just cannot move back to orchard</span>
              </div>
            </div>

            <div className='flex shrink-0 gap-2 p-4'>
              <Button variant='secondary' onClick={onClose} className='flex-1'>
                not now
              </Button>
              <Button variant='gradient' onClick={() => void handleBuild()} className='flex-1'>
                migrate
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
                <div className='mt-1 flex items-center gap-1.5 text-label'>
                  <span className='i-lucide-shield-check h-3.5 w-3.5 shrink-0' />
                  <span>confirmed on your zigner</span>
                </div>
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
              <div className='flex items-center justify-center gap-3 text-fg-muted'>
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-smartphone h-4 w-4' />
                  <span className='text-xs'>open zigner</span>
                </span>
                <span className='i-lucide-chevron-right h-3 w-3 shrink-0' />
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-scan h-4 w-4' />
                  <span className='text-xs'>scan</span>
                </span>
                <span className='i-lucide-chevron-right h-3 w-3 shrink-0' />
                <span className='flex items-center gap-1.5'>
                  <span className='i-lucide-check h-4 w-4' />
                  <span className='text-xs'>approve</span>
                </span>
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
            <p className='text-center text-sm text-fg-muted'>broadcasting to the network</p>
          </div>
        );

      case 'complete':
        return (
          <div className='flex flex-col items-center gap-4 p-8'>
            <div className='w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center'>
              <span className='i-lucide-check w-8 h-8 text-green-400' />
            </div>
            <h2 className='text-lg font-medium'>migrated to ironwood</h2>
            <p className='text-center text-sm text-fg-muted'>
              your funds are now in the active ironwood pool. your balance updates once the
              transaction confirms, and you can keep spending normally.
            </p>
            {txid && <p className='break-all font-mono text-xs text-fg-muted'>{txid}</p>}
            <Button variant='gradient' onClick={onClose} className='w-full mt-4'>
              done
            </Button>
          </div>
        );

      case 'error':
        // Pre-activation: the worker's fail-closed guard refused to build
        // because NU6.3 has not activated at this endpoint yet. This is not a
        // failure - migration simply is not available yet - so present it
        // calmly, without the red alarm styling, and without a "try again".
        if (isPreActivationError(error)) {
          return (
            <div className='flex flex-col items-center gap-4 p-8'>
              <div className='flex h-16 w-16 items-center justify-center rounded-full bg-primary/15'>
                <span className='i-lucide-clock h-8 w-8 text-zigner-gold' />
              </div>
              <h2 className='text-lg font-medium'>migration not available yet</h2>
              <p className='max-w-sm text-center text-sm text-fg-muted leading-snug'>
                orchard to ironwood migration becomes available once NU6.3 activates on the network.
                your orchard funds are safe in the meantime - nothing is required until then.
              </p>
              <Button variant='gradient' onClick={onClose} className='mt-2 w-full'>
                got it
              </Button>
            </div>
          );
        }
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

  // z-[60] sits above the bottom tabs + header (both z-50) so the migrate
  // footer buttons aren't overlapped by the nav bar during this takeover flow.
  return <div className='fixed inset-0 z-[60] overflow-y-auto bg-canvas'>{renderContent()}</div>;
}
