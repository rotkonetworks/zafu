/**
 * Every penumbra transaction screen (send, ibc withdraw, swap, stake) walks
 * the same steps as a zcash send: its form, review, sending, done or
 * stopped. The screen describes its transaction as data; this owns the
 * steps and hands the plan to the service worker (usePenumbraTransaction),
 * which opens the approval and broadcasts.
 */

import { useState, type ReactNode } from 'react';
import type { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { Done, Review, Sending, Stopped } from './send-ui';
import { STAGES, type SendProgress } from './send-stage';

export interface PenumbraTx {
  /** "send 5 um to alice": the sending meta and the stopped strip */
  sending: ReactNode;
  review: Omit<Parameters<typeof Review>[0], 'onEdit' | 'onConfirm'>;
  /** the line under the 済 stamp */
  done: ReactNode;
  plan: () => Promise<TransactionPlannerRequest>;
  label?: string;
  /** the network accepted it */
  onSent?: (txId: string) => void;
  /** a calmer reading of a failure, where the screen knows one */
  explainError?: (message: string) => string;
}

/** what was confirmed, kept as it was: the form may reset once it is sent */
type Shown = Pick<PenumbraTx, 'sending' | 'done'>;

type Step =
  | { at: 'form' | 'review' }
  | { at: 'sending'; shown: Shown; since: number; steps: SendProgress[] }
  | { at: 'done'; shown: Shown; txId: string }
  | { at: 'error'; shown: Shown; error: string };

export function PenumbraFlow({
  tx,
  onClose,
  doneActions,
  doneNote,
  children,
}: {
  tx: PenumbraTx;
  onClose: () => void;
  /** secondary actions on the done screen (save contact, ...) */
  doneActions?: (txId: string) => ReactNode;
  /** under the hash on the done screen */
  doneNote?: (txId: string) => ReactNode;
  /** the form; calling `review` moves on to the review step */
  children: (review: () => void) => ReactNode;
}) {
  const [step, setStep] = useState<Step>({ at: 'form' });
  const penumbraTx = usePenumbraTransaction();
  const edit = () => setStep({ at: 'form' });

  const send = async () => {
    const shown = { sending: tx.sending, done: tx.done };
    setStep({ at: 'sending', shown, since: Date.now(), steps: [] });
    try {
      const planRequest = await tx.plan();
      const { txId } = await penumbraTx.mutateAsync({
        planRequest,
        label: tx.label,
        onStep: s =>
          setStep(cur =>
            cur.at === 'sending' ? { ...cur, steps: [...cur.steps, { step: s }] } : cur,
          ),
      });
      tx.onSent?.(txId);
      setStep({ at: 'done', shown, txId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'transaction failed';
      setStep({ at: 'error', shown, error: tx.explainError?.(message) ?? message });
    }
  };

  const screen = () => {
    switch (step.at) {
      case 'form':
        return <>{children(() => setStep({ at: 'review' }))}</>;
      case 'review':
        return <Review {...tx.review} onEdit={edit} onConfirm={() => void send()} />;
      case 'sending':
        return (
          <Sending
            meta={step.shown.sending}
            stages={STAGES.penumbra}
            steps={step.steps}
            floor={0}
            since={step.since}
            hot
            onClose={onClose}
          />
        );
      case 'done':
        return (
          <Done
            line={step.shown.done}
            txHash={step.txId}
            note={doneNote?.(step.txId)}
            onDone={onClose}
          >
            {doneActions?.(step.txId)}
          </Done>
        );
      case 'error':
        return (
          <Stopped
            sending={step.shown.sending}
            error={step.error}
            onCancel={onClose}
            onRetry={edit}
          />
        );
    }
  };

  return <div className='flex h-full flex-col bg-canvas'>{screen()}</div>;
}
