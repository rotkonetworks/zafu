/**
 * Send or withdraw USDC on Hyperliquid: form, review, then one signed action
 * posted. The logic is hyperliquid-move.ts; this draws it.
 */

import { useState, type ReactNode } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import {
  microToUsdc,
  postHyperliquidAction,
  type SignedHyperliquidAction,
} from '@repo/wallet/networks/hyperliquid/client';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectGetMnemonic } from '../../../state/keyring';
import { useHyperliquidAccount } from '../../../hooks/hyperliquid';
import { AmountField, ToField } from './send-fields';
import { Done, Footer, Main, Review, Stopped } from './send-ui';
import {
  MOVES,
  checkMove,
  moveOf,
  signMove,
  stageAfter,
  type MoveFrom,
  type MoveMode,
  type MoveStage,
} from './hyperliquid-move';

type Step =
  | { at: 'form' | 'review' | 'posting' }
  | { at: MoveStage; signed?: SignedHyperliquidAction; reason?: string };

export const HyperliquidSend = ({ onClose }: { onClose: () => void }) => {
  const { keyId, path, address, balances } = useHyperliquidAccount();
  const getMnemonic = useStore(selectGetMnemonic);
  const [mode, setMode] = useState<MoveMode>('send');
  const [from, setFrom] = useState<MoveFrom>('perp');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ at: 'form' });

  const move = moveOf(mode, from);
  const look = MOVES[move];
  const available = balances.data?.[look.from];
  const { micro, problem, field } = checkMove({
    move,
    to,
    amount,
    balances: balances.data,
    own: address,
  });
  // the amount as it is signed, not as it was typed
  const signedAmount = micro === undefined ? amount : microToUsdc(micro);
  const sending = `${signedAmount} usdc · ${look.action}`;

  const post = async (signed: SignedHyperliquidAction, retried: boolean) => {
    setStep({ at: 'posting' });
    const answer = await postHyperliquidAction(signed);
    setStep({
      at: stageAfter(answer.outcome, retried),
      signed,
      reason: 'reason' in answer ? answer.reason : undefined,
    });
    void balances.refetch();
  };

  const confirm = async () => {
    if (!keyId || !path || !address || micro === undefined) {
      return;
    }
    setStep({ at: 'posting' });
    let signed: SignedHyperliquidAction;
    try {
      signed = signMove({
        mnemonic: await getMnemonic(keyId),
        path,
        address,
        move,
        to,
        micro,
        now: Date.now(),
      });
    } catch {
      // locked, or the key no longer gives this address: nothing was posted
      setStep({ at: 'refused' });
      return;
    }
    await post(signed, false);
  };

  if (!keyId) {
    return (
      <>
        <ScreenHeader title='send' onBack={onClose} />
        <Main className='pt-5'>
          <StatusSlot icon='i-ph-info'>
            sending on hyperliquid needs a seed wallet in zafu for now · this wallet&apos;s keys
            stay on its signer
          </StatusSlot>
        </Main>
      </>
    );
  }

  const screens: Record<Step['at'], () => ReactNode> = {
    form: () => (
      <>
        <ScreenHeader
          title={mode}
          onBack={onClose}
          meta={
            <Segmented
              label='send or withdraw'
              value={mode}
              onChange={setMode}
              options={[
                { value: 'send', label: 'send' },
                { value: 'withdraw', label: 'withdraw' },
              ]}
            />
          }
        />
        <Main className='gap-[18px] pt-5'>
          {mode === 'send' && (
            <Segmented
              label='from account'
              value={from}
              onChange={setFrom}
              options={[
                { value: 'perp', label: 'from perp' },
                { value: 'spot', label: 'from spot' },
              ]}
            />
          )}
          <ToField
            value={to}
            onChange={setTo}
            placeholder={mode === 'withdraw' ? '0x address on arbitrum' : '0x hyperliquid address'}
            warn={field === 'to'}
            helper={field === 'to' ? problem : undefined}
          />
          <AmountField
            value={amount}
            onChange={setAmount}
            unit='usdc'
            available={available === undefined ? undefined : microToUsdc(available)}
            onMax={available === undefined ? undefined : () => setAmount(microToUsdc(available))}
            canMax={!!available}
            warn={field === 'amount'}
            helper={
              field === 'amount'
                ? problem
                : look.fee !== undefined
                  ? `hyperliquid charges ${microToUsdc(look.fee)} usdc to withdraw`
                  : undefined
            }
          />
        </Main>
        <Footer>
          <Button
            className='grow'
            disabled={micro === undefined}
            onClick={() => setStep({ at: 'review' })}
          >
            review
          </Button>
        </Footer>
      </>
    ),
    review: () => (
      <Review
        lead={look.lead}
        amount={signedAmount}
        unit='usdc'
        rows={[
          ['action', look.action],
          ['arrives on', look.arrives],
          [
            'fee',
            look.fee === undefined ? 'none' : `${microToUsdc(look.fee)} usdc · hyperliquid's`,
          ],
        ]}
        privacy='public · anyone can see this move'
        confirm={look.confirm}
        onEdit={() => setStep({ at: 'form' })}
        onConfirm={() => void confirm()}
      >
        <div className='flex flex-col gap-1.5'>
          <span className='text-xs text-fg-muted'>to</span>
          <span className='break-all font-mono text-xs text-fg-high'>
            {to.trim().toLowerCase()}
          </span>
        </div>
      </Review>
    ),
    posting: () => (
      <>
        <ScreenHeader title='sending' backPath={false} />
        <Main className='pt-5'>
          <StatusSlot icon='i-ph-paper-plane-tilt'>{sending} · asking hyperliquid</StatusSlot>
        </Main>
      </>
    ),
    done: () => (
      <Done
        line={
          look.fee === undefined
            ? `${sending} · hyperliquid accepted it`
            : `${sending} · it reaches arbitrum in about 5 minutes`
        }
        onDone={onClose}
      />
    ),
    // turned down before anything moved: a fresh try signs a fresh action
    refused: () => (
      <Stopped
        title='not sent'
        sending={sending}
        error={`${'reason' in step && step.reason ? `hyperliquid says: ${step.reason}` : 'zafu could not sign this'} · nothing moved`}
        onCancel={onClose}
        onRetry={() => setStep({ at: 'form' })}
      />
    ),
    // "try again" posts the same signed action: its nonce is taken once
    unclear: () => (
      <Stopped
        title='no answer yet'
        sending={sending}
        error='hyperliquid did not answer, so zafu cannot tell if this went through · trying again sends the same signed request, which can never pay twice'
        onCancel={onClose}
        onRetry={() => 'signed' in step && step.signed && void post(step.signed, true)}
      />
    ),
    check: () => (
      <>
        <ScreenHeader title='please check your balance' onBack={onClose} />
        <Main className='pt-5'>
          <StatusSlot tone='warn' icon='i-ph-warning'>
            the first try got no answer, and the second was turned down
            {'reason' in step && step.reason ? ` (${step.reason})` : ''} · the first may have gone
            through, so your balance on home is what to trust before sending again
          </StatusSlot>
        </Main>
        <Footer>
          <Button className='grow' onClick={onClose}>
            back to wallet
          </Button>
        </Footer>
      </>
    ),
  };
  return <div className='flex h-full flex-col bg-canvas'>{screens[step.at]()}</div>;
};
