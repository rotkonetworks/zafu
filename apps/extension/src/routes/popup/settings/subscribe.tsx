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
import { buildSendTxInWorker } from '../../../state/keyring/network-worker';
import { SettingsScreen } from './settings-screen';

type PayState = 'idle' | 'building' | 'broadcasting' | 'sent' | 'polling' | 'activated' | 'error';

export const SubscribePage = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const pro = useStore(isPro);
  const days = useStore(selectDaysRemaining);
  const pending = useStore(selectPending);
  const { loadLicense, fetchLicense } = useStore(licenseSelector);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';

  const [months, setMonths] = useState(1);
  const [payState, setPayState] = useState<PayState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [zidPubkey, setZidPubkey] = useState<string | null>(null);
  const [ringPubkeyBytes, setRingPubkeyBytes] = useState<Uint8Array | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // derive ZID pubkey for payment memo + ring VRF pubkey for registration
  useEffect(() => {
    if (!keyInfo?.id) return;
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
  }, [keyInfo?.id, getMnemonic]);

  const memo = zidPubkey ? buildPaymentMemo(zidPubkey) : '';
  const amountZat = PRO_RATE_ZAT_PER_30_DAYS * months;
  const amountZec = (amountZat / 1e8).toFixed(2);
  const daysAdded = 30 * months;

  useEffect(() => { void loadLicense(); }, [loadLicense]);

  // cleanup poll on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  const checkLicense = useCallback(async () => {
    if (!zidPubkey) return false;
    try {
      const license = await fetchLicense(zidPubkey, ringPubkeyBytes ?? undefined);
      return !!license;
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

  const handlePay = useCallback(async () => {
    if (!keyInfo?.id || !memo) {
      setError('wallet not ready');
      setPayState('error');
      return;
    }
    if (!activeZcashWallet) {
      setError('no zcash wallet - switch to zcash network first');
      setPayState('error');
      return;
    }
    setPayState('building');
    setError(null);
    try {
      const mnemonic = await getMnemonic(keyInfo.id);
      const accountIndex = activeZcashWallet.accountIndex ?? 0;
      const mainnet = activeZcashWallet.mainnet ?? true;

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
  }, [keyInfo?.id, memo, activeZcashWallet, getMnemonic, zidecarUrl, amountZat, amountZec, startPolling]);

  const isZigner = keyInfo?.type === 'zigner-zafu';

  return (
    <SettingsScreen title='subscribe'>
      <div className='flex flex-col gap-4'>

        {/* status */}
        {pro ? (
          <div className='rounded border border-border/40 p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-green-400' />
              <span className='text-xs font-mono'>pro - {days} days remaining</span>
            </div>
          </div>
        ) : (
          <div className='rounded border border-border/40 p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-muted-foreground/40' />
              <span className='text-xs font-mono'>free plan</span>
            </div>
          </div>
        )}

        {/* features list */}
        <div className='text-[10px] font-mono text-muted-foreground/60'>
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
                <span className={pro ? 'i-lucide-check size-3 text-green-400' : 'size-3 text-muted-foreground/30'}>
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
            <div className='text-[9px] font-mono text-muted-foreground/60 mt-1'>
              {pending.requiredConfs === 0
                ? 'crediting...'
                : `${pending.pendingConfs}/${pending.requiredConfs} confirmations`}
            </div>
          </div>
        )}

        {/* payment flow */}
        {!pro && (
          <>
            <hr className='border-border/40' />

            {/* month selector */}
            <div className='flex items-center gap-3'>
              <button
                onClick={() => setMonths(m => Math.max(1, m - 1))}
                disabled={months <= 1 || payState !== 'idle'}
                className='rounded border border-border/40 px-3 py-1.5 text-sm font-mono text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors'
              >
                -
              </button>
              <div className='flex-1 text-center'>
                <span className='text-lg font-mono text-foreground'>{months}</span>
                <span className='text-xs font-mono text-muted-foreground ml-1.5'>
                  {months === 1 ? 'month' : 'months'}
                </span>
              </div>
              <button
                onClick={() => setMonths(m => Math.min(12, m + 1))}
                disabled={months >= 12 || payState !== 'idle'}
                className='rounded border border-border/40 px-3 py-1.5 text-sm font-mono text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors'
              >
                +
              </button>
            </div>

            <div className='text-center'>
              <span className='text-sm font-mono text-foreground'>{amountZec} ZEC</span>
              <span className='text-xs font-mono text-muted-foreground ml-2'>= {daysAdded} days</span>
            </div>

            {/* pay button (mnemonic wallets only) */}
            {payState === 'idle' && !isZigner && memo && (
              <button
                onClick={() => void handlePay()}
                className='rounded border border-primary/40 bg-primary/10 py-3 text-sm font-mono text-primary hover:bg-primary/20 transition-colors'
              >
                pay {amountZec} ZEC
              </button>
            )}

            {/* building/broadcasting */}
            {(payState === 'building' || payState === 'broadcasting') && (
              <div className='rounded border border-border/40 p-3 text-center'>
                <span className='text-xs font-mono text-muted-foreground animate-pulse'>
                  {payState === 'building' ? 'building transaction...' : 'broadcasting...'}
                </span>
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
                  <div className='text-[9px] font-mono text-muted-foreground/50 mt-1 break-all'>
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
                  <div className='text-[9px] font-mono text-muted-foreground/50 mt-1 break-all'>
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
                  className='text-[10px] font-mono text-muted-foreground hover:text-foreground mt-2'
                >
                  try again
                </button>
              </div>
            )}

            {/* manual copy fallback for zigner or external wallets */}
            {isZigner && (
              <div className='rounded border border-border/40 p-3'>
                <p className='text-[10px] font-mono text-muted-foreground mb-2'>
                  zigner wallets: send from another wallet
                </p>
                <button
                  onClick={() => copy(ROTKO_LICENSE_ADDRESS, 'address')}
                  className='w-full text-left mb-2'
                >
                  <span className='text-[9px] font-mono text-muted-foreground/50'>
                    {copied === 'address' ? 'copied' : 'tap to copy address'}
                  </span>
                  <p className='font-mono text-[10px] break-all'>{ROTKO_LICENSE_ADDRESS}</p>
                </button>
                {memo && (
                  <button onClick={() => copy(memo, 'memo')} className='w-full text-left'>
                    <span className='text-[9px] font-mono text-muted-foreground/50'>
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
                className='rounded border border-border/40 py-2 text-xs font-mono text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors'
              >
                {checking ? 'checking...' : checkResult ?? 'check payment status'}
              </button>
            )}
          </>
        )}

        {/* extend subscription for pro users */}
        {pro && !isZigner && memo && (
          <>
            <hr className='border-border/40' />
            <p className='text-[10px] font-mono text-muted-foreground/60'>add more time:</p>
            <div className='flex items-center gap-3'>
              <button
                onClick={() => setMonths(m => Math.max(1, m - 1))}
                disabled={months <= 1 || payState !== 'idle'}
                className='rounded border border-border/40 px-3 py-1.5 text-sm font-mono text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors'
              >
                -
              </button>
              <div className='flex-1 text-center'>
                <span className='text-lg font-mono text-foreground'>{months}</span>
                <span className='text-xs font-mono text-muted-foreground ml-1.5'>
                  {months === 1 ? 'month' : 'months'}
                </span>
              </div>
              <button
                onClick={() => setMonths(m => Math.min(12, m + 1))}
                disabled={months >= 12 || payState !== 'idle'}
                className='rounded border border-border/40 px-3 py-1.5 text-sm font-mono text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors'
              >
                +
              </button>
            </div>
            {payState === 'idle' && (
              <button
                onClick={() => void handlePay()}
                className='rounded border border-border/40 py-2 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors'
              >
                add {daysAdded} days ({amountZec} ZEC)
              </button>
            )}
            {(payState === 'building' || payState === 'broadcasting') && (
              <div className='text-center'>
                <span className='text-xs font-mono text-muted-foreground animate-pulse'>
                  {payState === 'building' ? 'building transaction...' : 'broadcasting...'}
                </span>
              </div>
            )}
            {payState === 'polling' && txid && (
              <div className='text-[9px] font-mono text-green-400'>
                payment sent - {txid.slice(0, 16)}...
              </div>
            )}
          </>
        )}
      </div>
    </SettingsScreen>
  );
};
