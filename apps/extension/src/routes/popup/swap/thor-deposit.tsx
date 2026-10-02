/**
 * Swap zec out over a THORNode-protocol route. The deposit is a t->t from
 * this pocket's transparent address to the vault with the memo in an
 * OP_RETURN, and refunds come back to that address. When
 * the address holds too little, a first step moves the shortfall there from
 * the shielded pool. Each step is reviewed and confirmed on its own; nothing
 * moves on until the user says so.
 */

import { useEffect, useState } from 'react';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Sensitive } from '../../../components/sensitive';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetVaultUnlock } from '../../../state/keyring';
import { activeAccountIndex, activeZcashStoreId } from '../../../state/pockets';
import {
  buildSendTxInWorker,
  planTransparentDepositInWorker,
  sendTransparentDepositInWorker,
} from '../../../state/keyring/network-worker';
import type { VaultUnlock } from '../../../state/keyring/types';
import type { DepositPlan } from '../../../workers/transparent-deposit';
import type { Quote } from '../../../state/swap/provider';
import { fromUnits } from '../../../state/swap/provider';
import { ROUTES } from '../../../state/swap/routes';
import { usePasswordGate } from '../../../hooks/password-gate';
import { usePoolNotes } from '../../../hooks/zcash-pool-balances';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { quoteSend } from '../send/spendable';
import { Main, PrivacyLine, Review, Stopped, shortAddress } from '../send/send-ui';

type Phase =
  | { at: 'planning' }
  | { at: 'move'; plan: DepositPlan }
  | { at: 'moving' }
  | { at: 'pay'; plan: DepositPlan }
  | { at: 'paying' }
  | { at: 'stopped'; error: string };

/** a shield-out confirms in a block or two; asking the light client is all this costs */
const MOVED_POLL_MS = 15_000;

const zec = (zat: string | bigint) => fromUnits(BigInt(zat), 8);

const lineOf = (e: unknown) =>
  e instanceof Error && e.message ? e.message : 'something broke on our side, not yours';

/** a step's own line for money that isn't there yet, over the worker's arithmetic */
const SHORT = {
  moving: "the shielded balance doesn't cover this yet · nothing was sent",
  paying: "your transparent address doesn't cover this yet · nothing was sent",
} as const;

export const ThorDeposit = ({
  quote,
  amountZat,
  onSent,
  onBack,
  onExpired,
}: {
  quote: Quote;
  amountZat: bigint;
  onSent: (txid: string) => void;
  onBack: () => void;
  onExpired: () => void;
}) => {
  const tAddress = useTransparentAddresses(true).tAddresses[0];
  const walletId = useStore(selectEffectiveKeyInfo)?.id;
  const storeId = useStore(activeZcashStoreId) ?? walletId;
  const pocket = useStore(activeAccountIndex);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const ironwood = usePoolNotes(storeId).ironwood;
  const { requestAuth, PasswordModal } = usePasswordGate();
  const [phase, setPhase] = useState<Phase>({ at: 'planning' });
  const [moved, setMoved] = useState(false);

  const req = tAddress
    ? {
        tAddress,
        to: quote.depositAddress,
        amountZat: amountZat.toString(),
        memo: quote.memo ?? '',
        mainnet: true,
      }
    : undefined;

  // price the deposit from the address's coins, and again while a move confirms
  useEffect(() => {
    if (!req || (phase.at !== 'planning' && phase.at !== 'moving')) {
      return;
    }
    let live = true;
    const ask = () =>
      planTransparentDepositInWorker(zidecarUrl, req).then(
        plan => {
          if (live && (plan.short === '0' || phase.at === 'planning')) {
            setPhase(plan.short === '0' ? { at: 'pay', plan } : { at: 'move', plan });
          }
        },
        e => live && phase.at === 'planning' && setPhase({ at: 'stopped', error: lineOf(e) }),
      );
    if (phase.at === 'planning') {
      void ask();
      return () => void (live = false);
    }
    const id = setInterval(() => void ask(), MOVED_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [phase.at, tAddress, zidecarUrl]);

  /** unlock, then run one confirmed step; a decline goes back to its review */
  const step = async (
    busy: { at: keyof typeof SHORT },
    run: (vault: VaultUnlock) => Promise<void>,
  ) => {
    if (!walletId || !(await requestAuth())) {
      return;
    }
    setPhase(busy);
    try {
      await run(await getVaultUnlock(walletId));
    } catch (e) {
      const line = lineOf(e);
      setPhase({ at: 'stopped', error: /insufficient/i.test(line) ? SHORT[busy.at] : line });
    }
  };

  const move = (plan: DepositPlan) =>
    step({ at: 'moving' }, async vault => {
      await buildSendTxInWorker(
        'zcash',
        storeId!,
        zidecarUrl,
        tAddress!,
        plan.short,
        '',
        pocket,
        true,
        vault,
      );
      setMoved(true);
    });

  const pay = (plan: DepositPlan) => {
    if (quote.expiresAt && quote.expiresAt <= Date.now()) {
      onExpired();
      return;
    }
    return step({ at: 'paying' }, async vault => {
      const { txid } = await sendTransparentDepositInWorker(
        storeId!,
        zidecarUrl,
        { ...req!, reviewedFee: plan.fee },
        vault,
      );
      onSent(txid);
    });
  };

  if (phase.at === 'stopped') {
    return (
      <div className='flex h-full flex-col bg-canvas'>
        <Stopped
          title='swap stopped'
          sending={
            <Sensitive>{`${zec(amountZat)} zec · ${shortAddress(quote.depositAddress)}`}</Sensitive>
          }
          error={phase.error}
          onCancel={onBack}
          onRetry={() => setPhase({ at: 'planning' })}
        />
      </div>
    );
  }

  if (phase.at === 'move') {
    const fee = quoteSend(
      ironwood.filter(n => !n.spent).map(n => BigInt(n.value)),
      BigInt(phase.plan.short),
      { transparentRecipient: true },
    ).feeZat;
    return (
      <div className='flex h-full flex-col bg-canvas'>
        {PasswordModal}
        <Review
          title='first, move zec'
          meta='1 / 2'
          lead='to your transparent address'
          amount={zec(phase.plan.short)}
          unit='zec'
          rows={[
            [
              'to',
              <span key='to' className='font-mono'>
                {shortAddress(tAddress!)}
              </span>,
            ],
            ['fee', <Sensitive key='fee'>{`${zec(fee)} zec`}</Sensitive>],
            ['then', 'the swap, reviewed next'],
          ]}
          privacy='public · the amount and your address show'
          confirm='move zec'
          onEdit={onBack}
          onConfirm={() => void move(phase.plan)}
        />
      </div>
    );
  }

  if (phase.at === 'pay') {
    return (
      <div className='flex h-full flex-col bg-canvas'>
        {PasswordModal}
        <Review
          title='review swap'
          meta={moved ? '2 / 2' : ''}
          amount={zec(amountZat)}
          unit='zec'
          rows={[
            ['network fee in', <Sensitive key='fee'>{`${zec(phase.plan.fee)} zec`}</Sensitive>],
            [
              'refunds to',
              <span key='refund' className='font-mono'>
                {shortAddress(tAddress!)}
              </span>,
            ],
          ]}
          confirm='confirm and send'
          onEdit={onBack}
          onConfirm={() => void pay(phase.plan)}
        >
          {/* the vault and the memo are what is being signed; shown in full, above the fold */}
          <dl className='-mt-2 flex flex-col gap-1 border border-border-soft bg-elev-1 px-3.5 py-3 text-xs'>
            <dt className='text-fg-muted'>to the {ROUTES[quote.route].label} vault</dt>
            <dd className='break-all font-mono text-fg-high'>{quote.depositAddress}</dd>
            <dt className='pt-1.5 text-fg-muted'>memo</dt>
            <dd className='break-all font-mono text-fg-high'>{quote.memo}</dd>
          </dl>
          <PrivacyLine>public · amount, vault and your address show</PrivacyLine>
        </Review>
      </div>
    );
  }

  const busy: Record<'planning' | 'moving' | 'paying', string> = {
    planning: 'reading your transparent address',
    moving: moved
      ? 'moved · waiting for the network to confirm it, then the swap'
      : 'moving zec to your transparent address',
    paying: 'sending the deposit',
  };
  return (
    <div className='flex h-full flex-col bg-canvas'>
      {PasswordModal}
      <ScreenHeader
        title='swap'
        onBack={onBack}
        meta={phase.at === 'moving' ? '1 / 2' : undefined}
      />
      <Main className='pt-5'>
        <StatusSlot tone='info' icon='i-ph-arrows-clockwise'>
          {busy[phase.at]}
        </StatusSlot>
      </Main>
    </div>
  );
};
