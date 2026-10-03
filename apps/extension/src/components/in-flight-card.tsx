/**
 * What zafu is doing right now: every tracked transaction that is still in
 * flight, plus the ones that failed or went quiet.
 * Renders nothing when there is nothing to show.
 */

import type { ReactNode } from 'react';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { discardTxOp, isTerminal, removeTxOps, writeTxOp, type TxOp } from '../tx-ops';
import { useTxOps } from '../tx-ops/use-tx-ops';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import { stopBuildInWorker } from '../state/keyring/network-worker';

const SLOT = {
  pending: { tone: 'gold', icon: 'i-zafu-enso', text: (op: TxOp) => op.step ?? 'working' },
  failed: { tone: 'danger', icon: 'i-ph-warning', text: (op: TxOp) => op.error ?? 'failed' },
  unknown: {
    tone: 'danger',
    icon: 'i-ph-warning',
    text: (op: TxOp) => op.error ?? 'no answer - please check activity',
  },
} as const;

/** one in-flight line: title over a quiet status */
export const PendingLine = ({
  tone,
  icon,
  title,
  status,
  action,
}: {
  tone: 'gold' | 'info' | 'danger';
  icon: string;
  title: ReactNode;
  status: string;
  action?: { label: string; onClick: () => void };
}) => (
  <StatusSlot tone={tone} icon={icon} action={action}>
    <span className='truncate text-[13px] text-fg-high normal-case'>{title}</span>
    <span className='truncate text-[11px] text-fg-muted'>{status}</span>
  </StatusSlot>
);

/**
 * Stop a zcash build from home, after the screen that started it has gone:
 * the worker stops it unless it is already broadcasting, which it says.
 */
const useStopFromHome = () => {
  const messages = useStore(messagesSelector);
  return async (op: TxOp) => {
    await writeTxOp(op.opId, { status: 'pending', step: 'stopping this send', stoppable: false });
    const outcome = await stopBuildInWorker('zcash', op.opId);
    if (outcome === 'committed') {
      await writeTxOp(op.opId, { status: 'pending', step: 'it is already on its way' });
      return;
    }
    await discardTxOp(op.opId);
    if (op.outboxId) {
      await messages.markOutgoingDiscarded(op.outboxId);
    }
  };
};

export const InFlightCard = ({ children }: { children?: ReactNode }) => {
  const stop = useStopFromHome();
  // a finished send was already announced once (toast or its own screen), and
  // a stopped one was stopped by the person looking at this
  const ops = useTxOps().filter(
    (op): op is TxOp & { status: Exclude<TxOp['status'], 'done' | 'discarded'> } =>
      op.status !== 'done' && op.status !== 'discarded',
  );
  if (!ops.length && !children) {
    return null;
  }
  return (
    <div className='flex flex-col gap-2'>
      {ops.map(op => {
        const slot = SLOT[op.status];
        return (
          <PendingLine
            key={op.opId}
            tone={slot.tone}
            icon={slot.icon}
            // labels carry asset symbols (USDC.inj), so no lowercasing
            title={op.label}
            status={slot.text(op)}
            action={
              isTerminal(op.status)
                ? { label: 'dismiss', onClick: () => void removeTxOps([op.opId]) }
                : op.stoppable && op.network === 'zcash'
                  ? { label: 'stop', onClick: () => void stop(op) }
                  : undefined
            }
          />
        );
      })}
      {children}
    </div>
  );
};
