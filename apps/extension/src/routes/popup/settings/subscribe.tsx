/**
 * subscribe - pay ZEC for pro features.
 * month selector, direct in-wallet payment, auto-poll for activation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { isPro, selectDaysRemaining, selectPending, licenseSelector } from '../../../state/license';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { ROTKO_LICENSE_ADDRESS, PRO_RATE_ZAT_PER_30_DAYS, PRO_FEATURES, FREE_FEATURES, buildPaymentMemo } from '@repo/wallet/license';
import { deriveZidCrossSite, deriveRingVrfSeed, DEFAULT_IDENTITY } from '../../../state/identity';
import {
  buildSendTxInWorker,
  completeSendTxInWorker,
  type SendTxUnsignedResult,
} from '../../../state/keyring/network-worker';
import {
  encodeZcashSignRequest,
  isZcashSignatureQR,
  parseZcashSignatureResponse,
  hexToBytes,
  bytesToHex,
} from '@repo/wallet/networks';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import { SettingsScreen } from './settings-screen';
import { usePasswordGate } from '../../../hooks/password-gate';

type PayState =
  | 'idle'
  | 'review'
  | 'building'
  | 'zigner-sign'    // show sign-request QR for zigner
  | 'zigner-scan'    // scan signature QR from zigner
  | 'broadcasting'
  | 'sent'
  | 'polling'
  | 'activated'
  | 'error';

/** live elapsed timer — ticks every second so the build screen never looks frozen */
function LiveTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startMs) return;
    const tick = () => setElapsed(Math.round((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return <span className='font-mono text-xs text-fg-muted tabular-nums'>{elapsed}s</span>;
}

export const SubscribePage = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const pro = useStore(isPro);
  const days = useStore(selectDaysRemaining);
  const pending = useStore(selectPending);
  const { fetchLicense } = useStore(licenseSelector);
  const currentLicense = useStore(s => s.license.license);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const enabledNetworks = useStore(s => s.keyRing.enabledNetworks);
  const zcashEnabled = enabledNetworks.includes('zcash');
  const isZignerWallet = keyInfo?.type === 'zigner-zafu';
  const needsZcashWalletRecord = isZignerWallet; // zigner/frost need stored zcash wallet
  const { requestAuth, PasswordModal } = usePasswordGate();

  const [months, setMonths] = useState(1);
  const [payState, setPayState] = useState<PayState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [zidPubkey, setZidPubkey] = useState<string | null>(null);
  const [ringPubkeyBytes, setRingPubkeyBytes] = useState<Uint8Array | null>(null);
  const [sendSteps, setSendSteps] = useState<Array<{ step: string; detail?: string; elapsedMs: number }>>([]);
  // zigner signing flow: unsigned tx produced at build, QR shown to user, signature scanned back
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const unsignedTxRef = useRef<SendTxUnsignedResult | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const buildStartRef = useRef<number>(0);
  // baseline `expires` captured before a new payment starts; polling waits
  // for the server's reported expires to INCREASE past this, so existing pro
  // licenses don't trigger an instant false "pro activated" after extension.
  const baselineExpiresRef = useRef<number>(0);

  // listen for send progress events from worker
  useEffect(() => {
    if (payState !== 'building' && payState !== 'broadcasting') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { step: string; detail?: string; elapsedMs: number };
      setSendSteps(prev => [...prev, detail]);
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [payState]);

  // derive ZID pubkey for payment memo + ring VRF pubkey for registration
  useEffect(() => {
    if (!keyInfo?.id) return;

    // zigner wallets: no mnemonic in zafu. use THIS wallet's ZID if imported
    // (via identity page QR scan). if missing, user needs to import it first.
    if (isZignerWallet) {
      const storedZid = keyInfo.insensitive?.['zid'] as string | undefined;
      if (storedZid) setZidPubkey(storedZid);
      return;
    }

    void (async () => {
      try {
        const mnemonic = await getMnemonic(keyInfo.id);
        const zid = deriveZidCrossSite(mnemonic, DEFAULT_IDENTITY);
        setZidPubkey(zid.publicKey);
        const seed = deriveRingVrfSeed(mnemonic);
        // @ts-expect-error dynamic WASM import resolved at runtime
        const wasm = await import(/* webpackIgnore: true */ '/ring-vrf-wasm/ring_vrf_wasm.js');
        await wasm.default({ module_or_path: '/ring-vrf-wasm/ring_vrf_wasm_bg.wasm' });
        const pubkeyHex = wasm.derive_ring_pubkey(seed) as string;
        setRingPubkeyBytes(new Uint8Array(pubkeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16))));
      } catch { /* WASM not available or not a mnemonic vault */ }
    })();
  }, [keyInfo?.id, getMnemonic, isZignerWallet, keyInfo?.insensitive]);

  const memo = zidPubkey ? buildPaymentMemo(zidPubkey) : '';
  const amountZat = PRO_RATE_ZAT_PER_30_DAYS * months;
  // strip trailing zeros so 0.001 shows as "0.001" not "0.00100000"
  const amountZec = (amountZat / 1e8).toFixed(8).replace(/\.?0+$/, '');
  const daysAdded = 30 * months;

  // cleanup poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  // returns true once the server-reported expires is strictly greater than
  // the baseline we captured before the payment started. for fresh subscribers
  // baseline is 0, so any pro license flips it; for extensions, we wait until
  // the new on-chain payment actually credits.
  const checkLicense = useCallback(async () => {
    if (!zidPubkey) return false;
    try {
      const license = await fetchLicense(zidPubkey, ringPubkeyBytes ?? undefined);
      if (!license) return false;
      return license.expires > baselineExpiresRef.current;
    } catch {
      return false;
    }
  }, [zidPubkey, ringPubkeyBytes, fetchLicense]);

  const manualCheck = useCallback(async () => {
    setChecking(true);
    setCheckResult(null);
    const ok = await checkLicense();
    setCheckResult(ok ? 'license activated' : 'no payment found yet');
    setChecking(false);
    setTimeout(() => setCheckResult(null), 4000);
  }, [checkLicense]);

  // start polling after payment sent
  const startPolling = useCallback(() => {
    setPayState('polling');
    if (pollRef.current) clearInterval(pollRef.current);
    let attempts = 0;
    pollRef.current = setInterval(() => {
      attempts++;
      void checkLicense().then(ok => {
        if (ok) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPayState('activated');
        } else if (attempts >= 20) {
          // stop after ~5 min, user can manually check
          if (pollRef.current) clearInterval(pollRef.current);
          setPayState('sent');
        }
      });
    }, 15_000);
  }, [checkLicense]);

  // step 1: show tx summary for review
  const handleReview = useCallback(() => {
    if (!keyInfo?.id || !memo) {
      setError('wallet not ready');
      setPayState('error');
      return;
    }
    if (!zcashEnabled) {
      setError('enable zcash network first to pay with ZEC');
      setPayState('error');
      return;
    }
    if (needsZcashWalletRecord && !activeZcashWallet) {
      setError('no zcash wallet record found for this wallet');
      setPayState('error');
      return;
    }
    setError(null);
    setPayState('review');
  }, [keyInfo?.id, memo, zcashEnabled, needsZcashWalletRecord, activeZcashWallet]);

  // step 2: confirm + password + broadcast
  const handleConfirm = useCallback(async () => {
    if (!keyInfo?.id) return;
    const authorized = await requestAuth();
    if (!authorized) { setPayState('review'); return; }

    baselineExpiresRef.current = currentLicense?.expires ?? 0;
    setSendSteps([]);
    buildStartRef.current = Date.now();
    setPayState('building');
    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const accountIndex = activeZcashWallet?.accountIndex ?? 0;
      const mainnet = activeZcashWallet?.mainnet ?? true;

      setPayState('broadcasting');
      const result = await buildSendTxInWorker(
        'zcash', keyInfo.id, zidecarUrl,
        ROTKO_LICENSE_ADDRESS, amountZat.toString(), memo,
        accountIndex, mainnet, mnemonic,
      );

      if ('txid' in result) {
        setTxid(result.txid);
        startPolling();
      } else {
        setError('unexpected result - wallet may need zigner signing');
        setPayState('error');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes('insufficient') || msg.includes('balance') || msg.includes('not enough')
          ? 'insufficient balance - you need at least ' + amountZec + ' ZEC'
          : msg
      );
      setPayState('error');
    }
  }, [keyInfo?.id, memo, activeZcashWallet, getMnemonic, zidecarUrl, amountZat, amountZec, startPolling, requestAuth, currentLicense]);

  // zigner variant: build unsigned tx, show sign-request QR, wait for signature scan.
  const handleZignerBuild = useCallback(async () => {
    if (!keyInfo?.id || !memo) return;
    if (!activeZcashWallet) {
      setError('no zcash wallet record found for this wallet');
      setPayState('error');
      return;
    }
    baselineExpiresRef.current = currentLicense?.expires ?? 0;
    setSendSteps([]);
    buildStartRef.current = Date.now();
    setPayState('building');
    try {
      const accountIndex = activeZcashWallet.accountIndex ?? 0;
      const mainnet = activeZcashWallet.mainnet ?? true;
      // mirror zcash-send: prefer stored ufvk, fall back to orchardFvk if it's a UFVK string
      const ufvk = activeZcashWallet.ufvk
        ?? (activeZcashWallet.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);

      const result = await buildSendTxInWorker(
        'zcash', keyInfo.id, zidecarUrl,
        ROTKO_LICENSE_ADDRESS, amountZat.toString(), memo,
        accountIndex, mainnet, undefined, ufvk,
      );
      if (!('sighash' in result)) {
        throw new Error('unexpected result from unsigned tx build');
      }
      unsignedTxRef.current = result;

      const signRequest = encodeZcashSignRequest({
        accountIndex,
        sighash: hexToBytes(result.sighash),
        orchardAlphas: result.alphas.map(a => hexToBytes(a)),
        summary: result.summary || `pay ${amountZec} zec for pro (+${daysAdded} days)`,
        mainnet,
      });
      setSignRequestQr(signRequest);
      setPayState('zigner-sign');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes('insufficient') || msg.includes('balance') || msg.includes('not enough')
          ? 'insufficient balance - you need at least ' + amountZec + ' ZEC'
          : msg
      );
      setPayState('error');
    }
  }, [keyInfo?.id, memo, activeZcashWallet, zidecarUrl, amountZat, amountZec, daysAdded, currentLicense]);

  const handleZignerSignatureScanned = useCallback(async (data: string) => {
    if (!isZcashSignatureQR(data)) {
      setError('invalid signature qr');
      setPayState('error');
      return;
    }
    if (!unsignedTxRef.current || !keyInfo?.id) {
      setError('missing unsigned transaction');
      setPayState('error');
      return;
    }
    setPayState('broadcasting');
    try {
      const sigResponse = parseZcashSignatureResponse(data);
      const signatures = {
        orchardSigs: sigResponse.orchardSigs.map(s => bytesToHex(s)),
        transparentSigs: sigResponse.transparentSigs.map(s => bytesToHex(s)),
      };
      const result = await completeSendTxInWorker(
        'zcash', keyInfo.id, zidecarUrl,
        unsignedTxRef.current.unsignedTx, signatures,
        unsignedTxRef.current.spendIndices,
      );
      unsignedTxRef.current = null;
      setSignRequestQr(null);
      setTxid(result.txid);
      startPolling();
    } catch (e) {
      unsignedTxRef.current = null;
      setError(e instanceof Error ? e.message : 'failed to broadcast transaction');
      setPayState('error');
    }
  }, [keyInfo?.id, zidecarUrl, startPolling]);

  return (
    <SettingsScreen title='subscribe'>
      <div className='flex flex-col gap-4'>

        {/* status */}
        {pro ? (
          <div className='rounded border border-border-hard-soft p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-green-400' />
              <span className='text-xs font-mono'>pro - {days} days remaining</span>
            </div>
          </div>
        ) : (
          <div className='rounded border border-border-hard-soft p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-elev-2-foreground/40' />
              <span className='text-xs font-mono'>free plan</span>
            </div>
          </div>
        )}

        {/* features list */}
        <div className='text-[10px] font-mono text-fg-dim'>
          <p className='mb-2'>free for everyone:</p>
          <ul className='flex flex-col gap-0.5 pl-2 mb-3'>
            {FREE_FEATURES.map(f => (
              <li key={f} className='flex items-center gap-1.5'>
                <span className='i-lucide-check size-3 text-green-400' />
                {f.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
          <p className='mb-2'>pro unlocks:</p>
          <ul className='flex flex-col gap-0.5 pl-2'>
            {PRO_FEATURES.map(f => (
              <li key={f} className='flex items-center gap-1.5'>
                <span className={pro ? 'i-lucide-check size-3 text-green-400' : 'size-3 text-fg-muted/30'}>
                  {pro ? '' : '\u00b7'}
                </span>
                {f.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </div>

        {/* pending payment from server */}
        {pending && pending.pendingZat > 0 && (
          <div className='rounded border border-yellow-500/30 p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-yellow-400 animate-pulse' />
              <span className='text-xs font-mono'>
                payment detected - {(pending.pendingZat / 1e8).toFixed(4)} ZEC
              </span>
            </div>
            <div className='text-[9px] font-mono text-fg-dim mt-1'>
              {pending.requiredConfs === 0
                ? 'crediting...'
                : `${pending.pendingConfs}/${pending.requiredConfs} confirmations`}
            </div>
          </div>
        )}

        {/* payment flow — works for new subscribers and for extending pro users */}
        <>
            <hr className='border-border-hard-soft' />

            {/* month selector */}
            <div className='flex items-center gap-3'>
              <button
                onClick={() => setMonths(m => Math.max(1, m - 1))}
                disabled={months <= 1 || payState !== 'idle'}
                className='rounded border border-border-hard-soft px-3 py-1.5 text-sm font-mono text-fg-muted hover:text-fg-high disabled:opacity-30 transition-colors'
              >
                -
              </button>
              <div className='flex-1 text-center'>
                <span className='text-lg font-mono text-fg'>{months}</span>
                <span className='text-xs font-mono text-fg-muted ml-1.5'>
                  {months === 1 ? 'month' : 'months'}
                </span>
              </div>
              <button
                onClick={() => setMonths(m => Math.min(12, m + 1))}
                disabled={months >= 12 || payState !== 'idle'}
                className='rounded border border-border-hard-soft px-3 py-1.5 text-sm font-mono text-fg-muted hover:text-fg-high disabled:opacity-30 transition-colors'
              >
                +
              </button>
            </div>

            <div className='text-center'>
              <span className='text-sm font-mono text-fg'>{amountZec} ZEC</span>
              <span className='text-xs font-mono text-fg-muted ml-2'>
                {pro ? `= +${daysAdded} days` : `= ${daysAdded} days`}
              </span>
            </div>

            {/* pay button — both wallet types go through review first */}
            {payState === 'idle' && memo && (
              <button
                onClick={handleReview}
                className='rounded border border-primary/40 bg-primary/10 py-3 text-sm font-mono text-zigner-gold hover:bg-primary/20 transition-colors'
              >
                {pro
                  ? `extend +${daysAdded} days${isZignerWallet ? ' with zigner' : ''}`
                  : isZignerWallet
                    ? `pay ${amountZec} ZEC with zigner`
                    : 'review payment'}
              </button>
            )}

            {/* review step — tx summary. zigner hands off to send page for QR
                signing; mnemonic builds + broadcasts locally after password gate. */}
            {payState === 'review' && (
              <div className='rounded border border-primary/40 bg-primary/5 p-3 flex flex-col gap-2'>
                <p className='text-xs font-mono text-fg-muted'>transaction summary</p>
                <div className='flex justify-between text-xs font-mono'>
                  <span className='text-fg-muted'>amount</span>
                  <span className='text-fg'>{amountZec} ZEC</span>
                </div>
                <div className='flex justify-between text-xs font-mono'>
                  <span className='text-fg-muted'>duration</span>
                  <span className='text-fg'>{daysAdded} days pro</span>
                </div>
                <div className='flex justify-between items-start text-xs font-mono gap-2'>
                  <span className='text-fg-muted shrink-0'>to</span>
                  <span className='text-fg text-right break-all text-[10px]'>{ROTKO_LICENSE_ADDRESS.slice(0, 20)}...{ROTKO_LICENSE_ADDRESS.slice(-8)}</span>
                </div>
                <div className='flex justify-between items-start text-xs font-mono gap-2'>
                  <span className='text-fg-muted shrink-0'>memo</span>
                  <span className='text-fg text-right break-all text-[10px]'>{memo.slice(0, 12)}...{memo.slice(-8)}</span>
                </div>
                {isZignerWallet && (
                  <p className='text-[10px] font-mono text-fg-muted mt-1'>
                    next: build an unsigned tx, scan the QR with your zigner device, then scan its signature back.
                  </p>
                )}
                <div className='flex gap-2 mt-2'>
                  <button
                    onClick={() => setPayState('idle')}
                    className='flex-1 rounded border border-border-hard-soft py-2 text-xs font-mono text-fg-muted hover:text-fg-high'
                  >
                    cancel
                  </button>
                  <button
                    onClick={() => {
                      if (isZignerWallet) void handleZignerBuild();
                      else void handleConfirm();
                    }}
                    className='flex-1 rounded border border-primary/40 bg-primary/10 py-2 text-xs font-mono text-zigner-gold hover:bg-primary/20'
                  >
                    {isZignerWallet ? 'continue to sign' : 'confirm & pay'}
                  </button>
                </div>
              </div>
            )}

            {/* zigner: show sign-request QR */}
            {payState === 'zigner-sign' && signRequestQr && (
              <div className='rounded border border-primary/40 bg-primary/5 p-3 flex flex-col gap-3 items-center'>
                <p className='text-xs font-mono text-fg-muted'>sign with zafu zigner</p>
                <QrDisplay data={signRequestQr} size={220} />
                <div className='text-[10px] font-mono text-fg-muted text-center leading-relaxed'>
                  1. open zafu zigner on your phone<br />
                  2. scan this qr<br />
                  3. review & approve the transaction<br />
                  4. tap &quot;scan signature&quot; below
                </div>
                <div className='flex gap-2 w-full'>
                  <button
                    onClick={() => { unsignedTxRef.current = null; setSignRequestQr(null); setPayState('idle'); }}
                    className='flex-1 rounded border border-border-hard-soft py-2 text-xs font-mono text-fg-muted hover:text-fg-high'
                  >
                    cancel
                  </button>
                  <button
                    onClick={() => setPayState('zigner-scan')}
                    className='flex-1 rounded border border-primary/40 bg-primary/10 py-2 text-xs font-mono text-zigner-gold hover:bg-primary/20'
                  >
                    scan signature
                  </button>
                </div>
              </div>
            )}

            {/* zigner: scan signature QR */}
            {payState === 'zigner-scan' && (
              <div className='rounded border border-primary/40 bg-primary/5 p-3 flex flex-col gap-2'>
                <QrScanner
                  inline
                  title='scan signature'
                  description="point camera at zafu zigner's signature qr"
                  onScan={(data) => void handleZignerSignatureScanned(data)}
                  onClose={() => setPayState('zigner-sign')}
                />
              </div>
            )}

            {/* building/broadcasting */}
            {(payState === 'building' || payState === 'broadcasting') && (
              <div className='rounded border border-border-hard-soft p-3 flex flex-col gap-2'>
                <div className='flex items-center justify-between'>
                  <span className='text-xs font-mono text-fg'>
                    {payState === 'building' ? 'building transaction' : 'broadcasting'}
                  </span>
                  <LiveTimer startMs={buildStartRef.current} />
                </div>
                {sendSteps.length > 0 ? (
                  <div className='flex flex-col gap-0.5 max-h-32 overflow-y-auto'>
                    {sendSteps.map((s, i) => {
                      const isLast = i === sendSteps.length - 1;
                      const prevMs = i > 0 ? sendSteps[i - 1]!.elapsedMs : 0;
                      const dur = ((s.elapsedMs - prevMs) / 1000).toFixed(1);
                      return (
                        <div key={i} className={`flex items-start gap-2 text-[10px] font-mono ${isLast ? 'text-fg' : 'text-fg-muted'}`}>
                          <span className='w-10 text-right shrink-0 tabular-nums'>{(s.elapsedMs / 1000).toFixed(1)}s</span>
                          <span>
                            {s.step}
                            {s.detail && <span className='text-fg-muted ml-1'>({s.detail})</span>}
                            {!isLast && Number(dur) >= 0.5 && (
                              <span className='text-fg-muted ml-1'>+{dur}s</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <span className='text-[10px] font-mono text-fg-muted animate-pulse'>preparing...</span>
                )}
              </div>
            )}

            {/* polling for activation */}
            {payState === 'polling' && (
              <div className='rounded border border-green-500/30 bg-green-500/10 p-3'>
                <div className='flex items-center gap-2'>
                  <span className='h-2 w-2 rounded-full bg-green-400 animate-pulse' />
                  <span className='text-xs font-mono text-green-400'>
                    payment sent - waiting for confirmation
                  </span>
                </div>
                {txid && (
                  <div className='text-[9px] font-mono text-fg-muted/50 mt-1 break-all'>
                    txid: {txid}
                  </div>
                )}
              </div>
            )}

            {/* activated */}
            {payState === 'activated' && (
              <div className='rounded border border-green-500/30 bg-green-500/10 p-3 text-center'>
                <span className='i-lucide-check size-5 text-green-400 inline-block mb-1' />
                <p className='text-sm font-mono text-green-400'>pro activated</p>
              </div>
            )}

            {/* sent but polling timed out */}
            {payState === 'sent' && (
              <div className='rounded border border-yellow-500/30 bg-yellow-500/10 p-3'>
                <p className='text-xs font-mono text-yellow-400'>
                  payment sent - may need a few more confirmations
                </p>
                {txid && (
                  <div className='text-[9px] font-mono text-fg-muted/50 mt-1 break-all'>
                    txid: {txid}
                  </div>
                )}
              </div>
            )}

            {/* error */}
            {payState === 'error' && (
              <div className='rounded border border-red-500/30 bg-red-500/10 p-3'>
                <p className='text-xs font-mono text-red-400'>{error}</p>
                <button
                  onClick={() => { setPayState('idle'); setError(null); }}
                  className='text-[10px] font-mono text-fg-muted hover:text-fg-high mt-2'
                >
                  try again
                </button>
              </div>
            )}

            {/* manual copy fallback — shown only when in-wallet pay isn't available
                 (e.g. zcash not enabled, or user wants to pay from external wallet) */}
            {isZignerWallet && (
              <div className='rounded border border-border-hard-soft p-3'>
                <p className='text-[10px] font-mono text-fg-muted mb-2'>
                  or pay from an external wallet
                </p>
                <button
                  onClick={() => copy(ROTKO_LICENSE_ADDRESS, 'address')}
                  className='w-full text-left mb-2'
                >
                  <span className='text-[9px] font-mono text-fg-muted/50'>
                    {copied === 'address' ? 'copied' : 'tap to copy address'}
                  </span>
                  <p className='font-mono text-[10px] break-all'>{ROTKO_LICENSE_ADDRESS}</p>
                </button>
                {memo && (
                  <button onClick={() => copy(memo, 'memo')} className='w-full text-left'>
                    <span className='text-[9px] font-mono text-fg-muted/50'>
                      {copied === 'memo' ? 'copied' : 'tap to copy memo'}
                    </span>
                    <p className='font-mono text-[10px] break-all'>{memo}</p>
                  </button>
                )}
              </div>
            )}

            {/* check button - always available */}
            {(payState === 'idle' || payState === 'sent' || payState === 'error') && (
              <button
                onClick={() => void manualCheck()}
                disabled={checking || !zidPubkey}
                className='rounded border border-border-hard-soft py-2 text-xs font-mono text-fg-muted hover:text-fg-high disabled:opacity-30 transition-colors'
              >
                {checking ? 'checking...' : checkResult ?? 'check payment status'}
              </button>
            )}
          </>
      </div>
      {PasswordModal}
    </SettingsScreen>
  );
};
