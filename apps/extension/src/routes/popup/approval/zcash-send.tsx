/**
 * Zcash multi-output transaction approval: a site (poker escrow) asks to
 * send one or more outputs. Presentation only - what is approved, signed
 * and returned is the outputs the site sent, unchanged. Walks the same
 * review / sending / done / stopped steps as every other send, on the
 * shared send-ui primitives, with the site's monogram and host shown the
 * way every other approval shows them.
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sensitive } from '../../../components/sensitive';
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { ApproveDeny } from './approve-deny';
import { ScreenHeader } from '../../../components/screen-header';
import {
  Main,
  Facts,
  Figure,
  PrivacyLine,
  Done,
  Sending,
  Stopped,
  shortAddress,
  isTransparentAddress,
  type Fact,
} from '../send/send-ui';
import { STAGES, type SendProgress } from '../send/send-stage';
import { RowGroup } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetVaultUnlock } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { activeAccountIndex, activeZcashStoreId } from '../../../state/pockets';
import { buildMultiSendTxInWorker } from '../../../state/keyring/network-worker';

interface Output {
  address: string;
  amount: number;
  memo?: string;
}

type Status =
  | { at: 'review' }
  | { at: 'signing'; since: number; steps: SendProgress[]; completed: number }
  | { at: 'done'; txids: string[] }
  | { at: 'error'; message: string };

const fmtZec = (zat: number) => (zat / 1e8).toFixed(4);

/** this output's own progress, stripped of its "output N: " prefix so it
 * reads against send-stage's per-stage regexes like a single send does */
const outputSteps = (steps: readonly SendProgress[], index: number): SendProgress[] =>
  steps.reduce<SendProgress[]>((acc, s) => {
    const m = /^output (\d+):\s*(.*)$/.exec(s.step);
    if (!m) {
      acc.push(s);
    } else if (Number(m[1]) - 1 === index) {
      acc.push({ step: m[2]!, detail: s.detail });
    }
    return acc;
  }, []);

export function ZcashSendApproval() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<Status>({ at: 'review' });
  const [outputs, setOutputs] = useState<Output[]>([]);
  const resultSentRef = useRef(false);

  const app = params.get('app') || '';
  const requestId = params.get('requestId') || '';
  const feePerOutput = Number(params.get('fee')) || 10_000;

  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const storeId = useStore(activeZcashStoreId);
  const pocketAccount = useStore(activeAccountIndex);

  useEffect(() => {
    try {
      const parsed = JSON.parse(decodeURIComponent(params.get('outputsJson') || '[]')) as Output[];
      setOutputs(
        parsed.filter(
          o =>
            o.address &&
            typeof o.address === 'string' &&
            typeof o.amount === 'number' &&
            o.amount > 0,
        ),
      );
    } catch {
      setOutputs([]);
    }
  }, []);

  useEffect(() => {
    if (status.at !== 'signing') {
      return;
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { step: string; detail?: string };
      setStatus(cur => {
        if (cur.at !== 'signing') {
          return cur;
        }
        const steps = [...cur.steps, detail];
        const match = /^output (\d+): complete/i.exec(detail.step);
        return match ? { ...cur, steps, completed: Number(match[1]) } : { ...cur, steps };
      });
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [status.at]);

  const totalFeeZat = feePerOutput * outputs.length;
  const totalOutputZat = outputs.reduce((s, o) => s + o.amount, 0);

  const sendResult = (result: unknown) => {
    if (resultSentRef.current) {
      return;
    }
    resultSentRef.current = true;
    void chrome.runtime.sendMessage({ type: 'zafu_zcash_send_result', requestId, result });
    setTimeout(() => window.close(), 500);
  };

  const deny = () => {
    sendResult({ success: false, denied: true });
  };

  const approve = async () => {
    if (!selectedKeyInfo) {
      setStatus({
        at: 'error',
        message: 'no wallet selected - open zafu and select a wallet first',
      });
      return;
    }
    if (selectedKeyInfo.type !== 'mnemonic') {
      setStatus({
        at: 'error',
        message:
          'multi-output send requires a mnemonic (hot) wallet - zigner/watch-only not supported',
      });
      return;
    }
    if (outputs.length === 0) {
      setStatus({ at: 'error', message: 'no valid outputs' });
      return;
    }

    setStatus({ at: 'signing', since: Date.now(), steps: [], completed: 0 });
    try {
      const vault = await getVaultUnlock(selectedKeyInfo.id);
      const mainnet = activeZcashWallet?.mainnet !== false;
      const workerOutputs = outputs.map(o => ({
        address: o.address.trim(),
        amount: String(o.amount),
        memo: o.memo,
      }));
      const result = await buildMultiSendTxInWorker(
        'zcash',
        storeId ?? selectedKeyInfo.id,
        zidecarUrl,
        workerOutputs,
        pocketAccount,
        mainnet,
        vault,
      );
      setStatus({ at: 'done', txids: result.txids });
      sendResult({ success: true, txids: result.txids, fees: result.fees });
    } catch (e: unknown) {
      setStatus({ at: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const host = hostnameOf(app);
  const sending = (
    <>
      send <Sensitive>{fmtZec(totalOutputZat)} zec</Sensitive>
      {outputs.length > 1 && ` across ${outputs.length} payments`} to {host}
    </>
  );

  if (status.at === 'signing') {
    const index = Math.min(status.completed, outputs.length - 1);
    return (
      <Sending
        meta={outputs.length > 1 ? `payment ${index + 1}/${outputs.length}` : host}
        stages={STAGES.zcash}
        steps={outputSteps(status.steps, index)}
        floor={0}
        since={status.since}
        hot
        onClose={() => window.close()}
      />
    );
  }

  if (status.at === 'done') {
    return (
      <Done
        line={sending}
        txHash={status.txids[0]}
        note={status.txids.length > 1 && `${status.txids.length} transactions sent`}
        onDone={() => window.close()}
      />
    );
  }

  if (status.at === 'error') {
    return (
      <Stopped
        sending={sending}
        error={status.message}
        onCancel={deny}
        onRetry={() => setStatus({ at: 'review' })}
      />
    );
  }

  const rows: Fact[] =
    outputs.length === 1
      ? [
          ['to', shortAddress(outputs[0]!.address)],
          ...(outputs[0]!.memo ? ([['memo', outputs[0]!.memo]] as Fact[]) : []),
          ['network fee', <Sensitive key='fee'>{fmtZec(totalFeeZat)} zec</Sensitive>],
        ]
      : [
          ['payments', `${outputs.length}`],
          ['network fee', <Sensitive key='fee'>~{fmtZec(totalFeeZat)} zec</Sensitive>],
        ];

  return (
    <div className='flex h-full min-h-0 flex-col bg-canvas'>
      <ScreenHeader title='review' backPath={false} meta='zcash' />
      <div className='flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-3'>
        <OriginIcon origin={app} size={28} />
        <span className='truncate text-sm text-fg-high'>{host}</span>
      </div>
      <Main className='gap-[22px] pt-6'>
        <p className='text-xs text-fg-muted'>
          {host} is asking you to send this. once sent, it can&apos;t be undone.
        </p>
        <div className='flex flex-col items-center gap-1.5 pb-1 pt-2'>
          <span className='text-xs text-fg-muted'>you send</span>
          <Figure amount={fmtZec(totalOutputZat)} unit='zec' />
        </div>
        <Facts rows={rows} />
        {outputs.length > 1 && (
          <RowGroup>
            {outputs.map((o, i) => (
              <div key={i} className='flex flex-col gap-1 px-3.5 py-2.5'>
                <div className='flex items-center justify-between gap-2'>
                  <span className='flex items-center gap-1.5 text-xs text-fg-muted'>
                    payment {i + 1}
                    <span
                      className={
                        isTransparentAddress(o.address)
                          ? 'bg-warn/10 px-1 py-0.5 text-[10px] text-warn lowercase'
                          : 'bg-success/10 px-1 py-0.5 text-[10px] text-success lowercase'
                      }
                    >
                      {isTransparentAddress(o.address) ? 'transparent' : 'shielded'}
                    </span>
                  </span>
                  <span className='text-[13px] text-network-accent'>
                    <Sensitive>{fmtZec(o.amount)} zec</Sensitive>
                  </span>
                </div>
                <span className='truncate text-[11px] text-fg-muted'>
                  {shortAddress(o.address)}
                </span>
              </div>
            ))}
          </RowGroup>
        )}
        <PrivacyLine>
          {outputs.some(o => isTransparentAddress(o.address))
            ? 'transparent outputs are public · shielded ones stay private'
            : 'shielded · amount and memo stay private'}
        </PrivacyLine>
      </Main>
      <ApproveDeny approve={() => void approve()} deny={deny} approveLabel='send' wait={3} />
    </div>
  );
}
