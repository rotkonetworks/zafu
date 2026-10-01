/**
 * What zafu is doing right now: every tracked transaction that is still in
 * flight, plus the ones that just ended (so a toast you missed is still here).
 * Renders nothing when there is nothing to show.
 */

import type { ReactNode } from 'react';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { isTerminal, removeTxOps, type TxNetwork, type TxOp } from '../tx-ops';
import { useTxOps } from '../tx-ops/use-tx-ops';

/** finished ops stay on the card this long */
const SHOW_FINISHED_MS = 2 * 60_000;

/** networks whose wallet lists its own broadcast-but-unconfirmed sends, so a
 *  finished op would show the same payment twice */
const TRACKS_OWN_PENDING: readonly TxNetwork[] = ['zcash'];

const visible = (op: TxOp, now: number): boolean =>
  op.status !== 'done' ||
  (!TRACKS_OWN_PENDING.includes(op.network) && now - op.updatedAt < SHOW_FINISHED_MS);

const SLOT = {
  pending: { tone: 'gold', icon: 'i-zafu-enso', text: (op: TxOp) => op.step ?? 'working' },
  done: { tone: 'info', icon: 'i-ph-check', text: () => 'sent' },
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

export const InFlightCard = ({ children }: { children?: ReactNode }) => {
  const now = Date.now();
  const ops = useTxOps().filter(op => visible(op, now));
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
                : undefined
            }
          />
        );
      })}
      {children}
    </div>
  );
};
