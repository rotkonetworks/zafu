/**
 * Zcash multi-output transaction approval popup.
 *
 * Flow:
 *   1. Parses outputs from URL params, shows them for review (3s safety delay)
 *   2. User clicks Approve - builds + signs each output via zcash worker
 *   3. Worker builds witness, proves (halo2), broadcasts each output
 *   4. Returns txids to the requesting dapp via zafu_zcash_send_result
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { buildMultiSendTxInWorker } from '../../../state/keyring/network-worker';

interface Output {
  address: string;
  amount: number;
  memo?: string;
}

export function ZcashSendApproval() {
  const [params] = useSearchParams();
  const [countdown, setCountdown] = useState(3);
  const [status, setStatus] = useState<'review' | 'signing' | 'done' | 'error'>('review');
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [error, setError] = useState('');
  const [progressText, setProgressText] = useState('');
  const [completedOutputs, setCompletedOutputs] = useState(0);
  const resultSentRef = useRef(false);

  const app = params.get('app') || 'unknown';
  const requestId = params.get('requestId') || '';
  const feePerOutput = Number(params.get('fee')) || 10_000;
  const favIcon = params.get('favIconUrl') || '';

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);

  useEffect(() => {
    try {
      const parsed = JSON.parse(decodeURIComponent(params.get('outputsJson') || '[]')) as Output[];
      // validate outputs at the boundary
      const validated = parsed.filter(o =>
        o.address && typeof o.address === 'string'
        && typeof o.amount === 'number' && o.amount > 0,
      );
      setOutputs(validated);
    } catch {
      setOutputs([]);
    }

    const timer = setInterval(() => {
      setCountdown(c => { if (c <= 1) { clearInterval(timer); return 0; } return c - 1; });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // listen for send progress from worker
  useEffect(() => {
    if (status !== 'signing') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { step: string; detail?: string };
      setProgressText(`${detail.step}${detail.detail ? ' - ' + detail.detail : ''}`);
      // track completed outputs from progress messages
      const match = detail.step.match(/output (\d+).*complete/i);
      if (match) {
        setCompletedOutputs(Number(match[1]));
      }
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [status]);

  // fee estimate: one fee per output (each is a separate tx)
  const totalFeeZat = feePerOutput * outputs.length;
  const totalOutputZat = outputs.reduce((s, o) => s + o.amount, 0);
  const totalZat = totalOutputZat + totalFeeZat;
  const fmtZec = (z: number) => (z / 1e8).toFixed(4);
  const shortAddr = (a: string) => a.length > 24 ? `${a.slice(0, 12)}...${a.slice(-8)}` : a;

  const sendResult = (result: unknown) => {
    if (resultSentRef.current) return;
    resultSentRef.current = true;
    void chrome.runtime.sendMessage({
      type: 'zafu_zcash_send_result',
      requestId,
      result,
    });
    // slight delay so user sees the final state
    setTimeout(() => window.close(), 500);
  };

  const handleDeny = () => {
    sendResult({ success: false, denied: true });
  };

  const handleApprove = async () => {
    if (!selectedKeyInfo) {
      setStatus('error');
      setError('no wallet selected - open zafu and select a wallet first');
      return;
    }

    if (selectedKeyInfo.type !== 'mnemonic') {
      setStatus('error');
      setError('multi-output send requires a mnemonic wallet (hot wallet). zigner/watch-only wallets are not supported for external send requests.');
      return;
    }

    if (outputs.length === 0) {
      setStatus('error');
      setError('no valid outputs');
      return;
    }

    setStatus('signing');
    setProgressText('initializing...');

    try {
      const walletId = selectedKeyInfo.id;
      const mnemonic = await getMnemonic(walletId);
      const mainnet = activeZcashWallet?.mainnet !== false;
      const accountIndex = activeZcashWallet?.accountIndex ?? 0;

      // convert outputs to worker format (amount as string in zatoshis)
      const workerOutputs = outputs.map(o => ({
        address: o.address.trim(),
        amount: String(o.amount),
        memo: o.memo,
      }));

      const result = await buildMultiSendTxInWorker(
        'zcash',
        walletId,
        zidecarUrl,
        workerOutputs,
        accountIndex,
        mainnet,
        mnemonic,
      );

      setStatus('done');
      setCompletedOutputs(outputs.length);
      sendResult({
        success: true,
        txids: result.txids,
        fees: result.fees,
      });
    } catch (e: unknown) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  };

  const isTransparent = (addr: string) => addr.startsWith('t1') || addr.startsWith('tm');

  return (
    <div className='flex flex-col h-full bg-canvas text-fg p-4'>
      {/* header */}
      <header className='flex items-center gap-3 mb-4'>
        {favIcon && <img src={favIcon} className='w-6 h-6 rounded-sm' alt='' />}
        <div>
          <div className='kicker'>zcash transaction</div>
          <div className='text-[10px] text-fg-dim tabular'>{app}</div>
        </div>
      </header>

      {/* warning banner */}
      <div className='rounded-md border border-zigner-gold/30 bg-zigner-gold/5 p-3 mb-4'>
        <div className='kicker mb-1 text-zigner-gold/80'>review carefully</div>
        <div className='text-[10px] text-fg'>
          Sending <span className='tabular text-zigner-gold'>{fmtZec(totalOutputZat)} ZEC</span>
          {' '}across {outputs.length} output{outputs.length > 1 ? 's' : ''}
          {' '}(+ ~<span className='tabular text-fg-muted'>{fmtZec(totalFeeZat)}</span> fee)
        </div>
      </div>

      {/* outputs list */}
      <div className='flex-1 overflow-auto mb-4'>
        <div className='kicker mb-2'>
          {outputs.length} output{outputs.length > 1 ? 's' : ''} — each sent as a separate transaction
        </div>

        {outputs.map((o, i) => (
          <div key={i} className='rounded-md border border-border-soft bg-elev-1 p-3 mb-2'>
            <div className='flex justify-between items-start mb-1'>
              <div className='flex items-center gap-1.5'>
                <div className='text-[10px] text-fg-dim lowercase tracking-[0.04em]'>output {i + 1}</div>
                {isTransparent(o.address) ? (
                  <span className='rounded-sm text-[9px] px-1 py-0.5 bg-orange-500/10 text-orange-400 lowercase tracking-[0.08em]'>transparent</span>
                ) : (
                  <span className='rounded-sm text-[9px] px-1 py-0.5 bg-success/10 text-success lowercase tracking-[0.08em]'>shielded</span>
                )}
                {status === 'signing' && i < completedOutputs && (
                  <span className='text-[9px] text-success lowercase tracking-[0.04em]'>sent</span>
                )}
              </div>
              <div className='text-[13px] tabular text-zigner-gold'>{fmtZec(o.amount)} ZEC</div>
            </div>
            <div className='text-[10px] tabular text-fg-muted break-all'>{shortAddr(o.address)}</div>
            {o.memo && (
              <div className='text-[10px] text-fg-dim mt-1 italic truncate' title={o.memo}>
                {o.memo.length > 80 ? o.memo.slice(0, 80) + '...' : o.memo}
              </div>
            )}
          </div>
        ))}

        {/* fee display */}
        <div className='rounded-md border border-border-soft bg-elev-1 p-3'>
          <div className='flex justify-between'>
            <div className='text-[10px] text-fg-dim lowercase tracking-[0.04em]'>network fee (per tx × {outputs.length})</div>
            <div className='text-[10px] tabular text-fg-muted'>~{fmtZec(totalFeeZat)} ZEC</div>
          </div>
        </div>

        {/* total */}
        <div className='mt-3 pt-3 border-t border-border-soft flex justify-between items-baseline'>
          <div className='kicker'>total (incl. fees)</div>
          <div className='text-[15px] tabular text-zigner-gold'>{fmtZec(totalZat)} ZEC</div>
        </div>
      </div>

      {/* progress indicator */}
      {status === 'signing' && progressText && (
        <div className='rounded-md border border-border-soft bg-elev-1 p-2 mb-3 text-fg-muted text-[11px]'>
          <div className='flex items-center gap-2'>
            <div className='h-3 w-3 animate-spin rounded-full border border-zigner-gold border-t-transparent' />
            <span className='truncate'>{progressText}</span>
          </div>
          {outputs.length > 1 && (
            <div className='mt-1 rule overflow-hidden rounded-sm'>
              <div
                className='bg-zigner-gold h-full transition-all duration-500'
                style={{ width: `${Math.round((completedOutputs / outputs.length) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* error display */}
      {error && (
        <div className='rounded-md border border-red-500/40 bg-red-500/10 p-2 mb-3 text-red-400 text-xs break-words'>
          {error}
        </div>
      )}

      {/* action buttons */}
      <div className='flex gap-3'>
        <button
          className='flex-1 py-2.5 rounded-md border border-border-soft bg-elev-1 text-[13px] text-fg-muted hover:text-fg-high hover:bg-elev-2 lowercase tracking-[0.04em]'
          onClick={handleDeny}
          disabled={status === 'signing'}
        >deny</button>
        <button
          className={cn(
            'flex-1 py-2.5 rounded-md text-[13px] lowercase tracking-[0.04em] transition-colors',
            countdown > 0 || status !== 'review'
              ? 'bg-elev-1 text-fg-dim cursor-not-allowed'
              : 'bg-zigner-gold text-zigner-dark hover:bg-zigner-gold-light',
          )}
          disabled={countdown > 0 || status !== 'review'}
          onClick={handleApprove}
        >
          {countdown > 0 ? `approve (${countdown})`
            : status === 'signing' ? `signing ${completedOutputs}/${outputs.length}...`
            : status === 'done' ? 'sent'
            : status === 'error' ? 'failed'
            : 'approve & send'}
        </button>
      </div>
    </div>
  );
}
