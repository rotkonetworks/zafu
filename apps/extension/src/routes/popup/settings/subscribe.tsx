/**
 * subscribe — pay 0.01 ZEC/month for pro features.
 * shows address, amount, memo format, and current license status.
 */

import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { isPro, selectDaysRemaining, selectPending, licenseSelector } from '../../../state/license';
import { ROTKO_LICENSE_ADDRESS, PRO_RATE_ZAT_PER_30_DAYS, PRO_FEATURES, buildPaymentMemo } from '@repo/wallet/license';
import { deriveZproKey } from '../../../state/identity';
import { SettingsScreen } from './settings-screen';

export const SubscribePage = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const pro = useStore(isPro);
  const days = useStore(selectDaysRemaining);
  const pending = useStore(selectPending);
  const { loadLicense, fetchLicense } = useStore(licenseSelector);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [zproKey, setZproKey] = useState<string | null>(null);

  // derive stable zpro license key (never rotates, survives ZID rotation)
  useEffect(() => {
    if (!keyInfo?.id) return;
    void (async () => {
      try {
        const mnemonic = await getMnemonic(keyInfo.id);
        const { publicKey } = deriveZproKey(mnemonic);
        setZproKey(publicKey);
      } catch { /* not a mnemonic vault */ }
    })();
  }, [keyInfo?.id, getMnemonic]);

  const memo = zproKey ? buildPaymentMemo(zproKey) : '';
  const rateZec = (PRO_RATE_ZAT_PER_30_DAYS / 1e8).toFixed(2);

  useEffect(() => { void loadLicense(); }, [loadLicense]);

  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  };

  const checkLicense = useCallback(async () => {
    if (!zproKey) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const license = await fetchLicense(zidecarUrl, zproKey);
      if (license) {
        setCheckResult('license activated');
      } else {
        await loadLicense();
        setCheckResult('no payment found yet');
      }
    } catch {
      setCheckResult('could not reach server');
    }
    setChecking(false);
    setTimeout(() => setCheckResult(null), 4000);
  }, [zproKey, zidecarUrl, fetchLicense, loadLicense]);

  return (
    <SettingsScreen title='subscribe'>
      <div className='flex flex-col gap-4'>

        {/* status */}
        {pro ? (
          <div className='rounded border border-border/40 p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-green-400' />
              <span className='text-xs font-mono'>pro — {days} days remaining</span>
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

        {/* pro features list */}
        <div className='text-[10px] font-mono text-muted-foreground/60'>
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

        {/* pending payment */}
        {pending && pending.pendingZat > 0 && (
          <div className='rounded border border-yellow-500/30 p-3'>
            <div className='flex items-center gap-2'>
              <span className='h-2 w-2 rounded-full bg-yellow-400 animate-pulse' />
              <span className='text-xs font-mono'>
                payment detected — {(pending.pendingZat / 1e8).toFixed(4)} ZEC
              </span>
            </div>
            <div className='text-[9px] font-mono text-muted-foreground/60 mt-1'>
              {pending.requiredConfs === 0
                ? 'crediting...'
                : `${pending.pendingConfs}/${pending.requiredConfs} confirmations`}
            </div>
          </div>
        )}

        {!pro && (
          <>
            <hr className='border-border/40' />

            <div className='text-xs font-mono text-muted-foreground'>
              <span className='text-foreground'>{rateZec} ZEC = 30 days.</span> send any amount — time credits proportionally.
            </div>
            <div className='text-[9px] font-mono text-muted-foreground/50'>
              0.03 ZEC = 90 days · 0.12 ZEC = 1 year
            </div>

            {/* address */}
            <button
              onClick={() => copy(ROTKO_LICENSE_ADDRESS, 'address')}
              className='w-full rounded border border-border/40 p-3 text-left hover:bg-muted/30 transition-colors'
            >
              <div className='text-[9px] text-muted-foreground/50 font-mono mb-1'>
                {copied === 'address' ? 'copied' : 'tap to copy address'}
              </div>
              <div className='font-mono text-[10px] break-all leading-relaxed'>
                {ROTKO_LICENSE_ADDRESS}
              </div>
            </button>

            {/* memo */}
            {memo && (
              <button
                onClick={() => copy(memo, 'memo')}
                className='w-full rounded border border-border/40 p-3 text-left hover:bg-muted/30 transition-colors'
              >
                <div className='text-[9px] text-muted-foreground/50 font-mono mb-1'>
                  {copied === 'memo' ? 'copied' : 'tap to copy memo (required)'}
                </div>
                <div className='font-mono text-[10px] break-all'>
                  {memo}
                </div>
              </button>
            )}

            <p className='text-[9px] text-muted-foreground/40 font-mono'>
              include the memo exactly as shown. your zid identifies the payment.
              license activates within ~2 minutes of confirmation.
            </p>

            {/* check button */}
            <button
              onClick={() => void checkLicense()}
              disabled={checking}
              className='rounded border border-border/40 py-2 text-xs font-mono text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors'
            >
              {checking ? 'checking...' : checkResult ?? 'check payment status'}
            </button>
          </>
        )}
      </div>
    </SettingsScreen>
  );
};
