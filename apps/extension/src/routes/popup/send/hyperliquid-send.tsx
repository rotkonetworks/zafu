/**
 * Send or withdraw USDC on Hyperliquid, or withdraw ZEC through Unit: form,
 * review, then one signed action posted. The logic is hyperliquid-move.ts;
 * this draws it.
 */

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { shorten } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { Segmented } from '@repo/ui/components/ui/segmented';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import {
  buildHyperliquidAction,
  buildUzecSend,
  microToUsdc,
  postHyperliquidAction,
  zatToZec,
  type SignedHyperliquidAction,
} from '@repo/wallet/networks/hyperliquid/client';
import { unitWithdrawAddress, unitZecEstimate } from '@repo/wallet/networks/hyperliquid/unit';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectGetMnemonic } from '../../../state/keyring';
import { selectZcashIsMainnet } from '../../../state/wallets';
import {
  claimTAddressOnPurpose,
  nextTAddressOnPurpose,
} from '../../../hooks/use-transparent-addresses';
import { zecMoves } from '../../../hyperliquid/zec-moves';
import { useHyperliquidAccount } from '../../../hooks/hyperliquid';
import { AmountField, ToField } from './send-fields';
import { Done, Footer, Main, Review, Stopped } from './send-ui';
import {
  MOVES,
  checkMove,
  checkZecWithdraw,
  moveOf,
  signMove,
  stageAfter,
  type MoveFrom,
  type MoveStage,
} from './hyperliquid-move';

/** an address exactly as it is signed, whole */
const Signed = ({ label, value }: { label: string; value: string }) => (
  <div className='flex flex-col gap-1.5'>
    <span className='text-xs text-fg-muted'>{label}</span>
    <span className='break-all font-mono text-xs text-fg-high'>{value}</span>
  </div>
);

type Step =
  | { at: 'form' | 'review' | 'posting' }
  | { at: MoveStage; signed?: SignedHyperliquidAction; reason?: string };

/** usdc to a hyperliquid address, usdc to arbitrum, or uzec out to zcash through unit */
type Mode = 'send' | 'withdraw' | 'zec';

export const HyperliquidSend = ({ onClose, zec }: { onClose: () => void; zec?: boolean }) => {
  const { keyId, path, name, address, balances } = useHyperliquidAccount();
  const getMnemonic = useStore(selectGetMnemonic);
  const queryClient = useQueryClient();
  const zcashMainnet = useStore(selectZcashIsMainnet);
  const [mode, setMode] = useState<Mode>(zec ? 'zec' : 'send');
  const [from, setFrom] = useState<MoveFrom>('perp');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ at: 'form' });

  const isZec = mode === 'zec';
  const move = moveOf(isZec ? 'send' : mode, isZec ? 'spot' : from);
  const usdc = checkMove({ move, to, amount, balances: balances.data, own: address });
  const zecOut = checkZecWithdraw(amount, balances.data?.uzec);
  // one shape for both, so the screens below never ask which it is
  const look = isZec
    ? {
        unit: 'zec',
        action: 'withdraw zec through unit',
        arrives: 'a fresh zcash address of yours',
        lead: 'you withdraw',
        confirm: 'withdraw',
        available: balances.data && zatToZec(balances.data.uzec),
        units: zecOut.zat,
        signed: zecOut.zat === undefined ? amount : zatToZec(zecOut.zat),
        problem: zecOut.problem,
        field: zecOut.problem ? ('amount' as const) : undefined,
      }
    : {
        unit: 'usdc',
        ...MOVES[move],
        available: balances.data && microToUsdc(balances.data[MOVES[move].from]),
        units: usdc.micro,
        // the amount as it is signed, not as it was typed
        signed: usdc.micro === undefined ? amount : microToUsdc(usdc.micro),
        problem: usdc.problem,
        field: usdc.field,
      };
  const sending = `${look.signed} ${look.unit} · ${look.action}`;

  // a zec withdrawal pays out to a fresh address of the zcash wallet; Unit's
  // address for it is asked for, and verified, when review opens
  const reviewingZec = isZec && step.at === 'review';
  const fresh = useQuery({
    queryKey: ['hyperliquidZecOut', keyId],
    queryFn: async () => (await nextTAddressOnPurpose(useStore.getState(), true)) ?? null,
    enabled: reviewingZec,
    gcTime: 0,
    retry: false,
  });
  const unitTo = useQuery({
    queryKey: ['unitWithdrawAddress', fresh.data?.address],
    queryFn: () => unitWithdrawAddress(fresh.data!.address),
    enabled: reviewingZec && !!fresh.data,
    staleTime: Infinity,
    retry: false,
  });
  const estimate = useQuery({
    queryKey: ['unitZecEstimate'],
    queryFn: () => unitZecEstimate(),
    enabled: isZec,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const post = async (signed: SignedHyperliquidAction, retried: boolean) => {
    setStep({ at: 'posting' });
    const answer = await postHyperliquidAction(signed);
    const at = stageAfter(answer.outcome, retried);
    if (isZec && at !== 'refused' && address) {
      // followed on home from here; Unit names it by sender and nonce
      await zecMoves.save({
        v: 1,
        id: String(signed.nonce),
        way: 'withdraw',
        wallet: keyId!,
        account: address,
        from: name,
        zat: String(look.units),
        at: signed.nonce,
        tx: `${address}:${signed.nonce}`,
      });
    }
    setStep({ at, signed, reason: 'reason' in answer ? answer.reason : undefined });
    void balances.refetch();
  };

  const confirm = async () => {
    if (!keyId || !path || !address || look.units === undefined) {
      return;
    }
    if (isZec && (!fresh.data || !unitTo.data)) {
      return;
    }
    setStep({ at: 'posting' });
    let signed: SignedHyperliquidAction;
    try {
      let action;
      if (isZec) {
        // the address review showed becomes this wallet's for good, and tracked
        const t = await claimTAddressOnPurpose(useStore.getState(), true, queryClient);
        if (t.address !== fresh.data!.address) {
          throw new Error('the fresh address moved on');
        }
        action = buildUzecSend(unitTo.data!, look.units, Date.now());
      } else {
        action = buildHyperliquidAction(move, to.trim(), look.units, Date.now());
      }
      signed = signMove({ mnemonic: await getMnemonic(keyId), path, address, action });
    } catch {
      // locked, or the key or the fresh address no longer what review showed: nothing was posted
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
          title={isZec ? 'withdraw zec' : mode}
          onBack={onClose}
          meta={
            <Segmented
              label='send or withdraw'
              value={mode}
              onChange={next => {
                // usdc and zec are not the same number
                setAmount('');
                setMode(next);
              }}
              options={[
                { value: 'send', label: 'send' },
                { value: 'withdraw', label: 'withdraw' },
                { value: 'zec', label: 'zec' },
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
          {isZec ? (
            <StatusSlot icon='i-ph-info'>
              {zcashMainnet
                ? 'your uzec leaves hyperliquid and unit pays zec to a fresh public address of this wallet · it can be shielded once it arrives'
                : 'zec withdrawals pay out on zcash mainnet · please switch zcash off its testnet first'}
            </StatusSlot>
          ) : (
            <ToField
              value={to}
              onChange={setTo}
              placeholder={
                mode === 'withdraw' ? '0x address on arbitrum' : '0x hyperliquid address'
              }
              warn={look.field === 'to'}
              helper={look.field === 'to' ? look.problem : undefined}
            />
          )}
          <AmountField
            value={amount}
            onChange={setAmount}
            unit={look.unit}
            available={look.available}
            onMax={look.available === undefined ? undefined : () => setAmount(look.available!)}
            canMax={!!look.available && look.available !== '0'}
            warn={look.field === 'amount'}
            helper={
              look.field === 'amount'
                ? look.problem
                : 'fee' in look && look.fee !== undefined
                  ? `hyperliquid charges ${microToUsdc(look.fee)} usdc to withdraw`
                  : isZec && estimate.data
                    ? `unit's network fee ${zatToZec(estimate.data.withdrawFeeZat)} zec · about ${estimate.data.withdrawEta}`
                    : undefined
            }
          />
        </Main>
        <Footer>
          <Button
            className='grow'
            disabled={look.units === undefined || (isZec && !zcashMainnet)}
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
        amount={look.signed}
        unit={look.unit}
        rows={[
          ['from account', `${name} · ${shorten(address ?? '', 6, 4)}`],
          ['action', look.action],
          ['arrives on', look.arrives],
          isZec
            ? [
                "unit's fee",
                estimate.data
                  ? `${zatToZec(estimate.data.withdrawFeeZat)} zec · about ${estimate.data.withdrawEta}`
                  : 'a network fee, taken from the amount',
              ]
            : [
                'fee',
                'fee' in look && look.fee !== undefined
                  ? `${microToUsdc(look.fee)} usdc · hyperliquid's`
                  : 'none',
              ],
        ]}
        privacy={
          isZec
            ? 'public · it can be shielded once it arrives'
            : 'public · anyone can see this move'
        }
        confirm={look.confirm}
        onEdit={() => setStep({ at: 'form' })}
        onConfirm={() => void confirm()}
      >
        {isZec ? (
          unitTo.data && fresh.data ? (
            <>
              <Signed label="to unit's address, signed by its guardians" value={unitTo.data} />
              <Signed label='which pays your fresh public address' value={fresh.data.address} />
            </>
          ) : (
            <StatusSlot
              tone={unitTo.isError || fresh.isError || fresh.data === null ? 'warn' : 'info'}
              icon='i-ph-info'
            >
              {unitTo.isError
                ? `${unitTo.error.message} · nothing was sent`
                : fresh.isError || fresh.data === null
                  ? 'zafu could not make a fresh zcash address just now · nothing was sent'
                  : 'asking unit for your withdrawal address'}
            </StatusSlot>
          )
        ) : (
          <Signed label='to' value={to.trim().toLowerCase()} />
        )}
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
          isZec
            ? `${sending} · home follows it until the zec arrives`
            : !('fee' in look) || look.fee === undefined
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
