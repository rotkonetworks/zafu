/**
 * Swap zec out over a THORNode-protocol route. The deposit is a t->t from
 * the swap's own fresh transparent address (claimed for this swap alone) to
 * the vault with the memo in an OP_RETURN, and change and refunds come back
 * to that same address. When the address holds too little, a first step
 * moves the shortfall there from the shielded pool. Each step is reviewed and
 * confirmed on its own; nothing moves on until the user says so.
 *
 * A zigner wallet signs both steps on the device, one qr round each: the move
 * is an ordinary shielded send to the swap's address, and the deposit is the
 * same reviewed bytes a hot wallet signs, finished here and checked against
 * the review before it is broadcast.
 */

import { useEffect, useMemo, useState } from 'react';
import { useStore as useZustand } from 'zustand';
import { Button } from '@repo/ui/components/ui/button';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { Sensitive } from '../../../components/sensitive';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetVaultUnlock } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { activeAccountIndex, activeZcashStoreId } from '../../../state/pockets';
import {
  applySignatureContributionsInWorker,
  buildColdDepositInWorker,
  buildSendTxInWorker,
  buildSendTxPcztInWorker,
  completeColdDepositInWorker,
  planTransparentDepositInWorker,
  sendTransparentDepositInWorker,
  type SignatureContribution,
} from '../../../state/keyring/network-worker';
import { walletKind } from '../../../signing/wallet-kind';
import { signAndBroadcast } from '../../../signing/cold-send';
import { createZignerRound, isZignerDeclined } from '../../../signing/zigner-round';
import { ZignerRoundView } from '../../../components/zigner-round-view';
import type { VaultUnlock } from '../../../state/keyring/types';
import { checkVault, type DepositPlan } from '../../../workers/transparent-deposit';
import type { Quote } from '../../../state/swap/provider';
import { fromUnits } from '../../../state/swap/provider';
import { ROUTES } from '../../../state/swap/routes';
import { usePasswordGate } from '../../../hooks/password-gate';
import { usePoolNotes } from '../../../hooks/zcash-pool-balances';
import type { SwapTAddress } from '../../../hooks/use-transparent-addresses';
import { quoteSend } from '../send/spendable';
import { Footer, Main, PrivacyLine, Review, Stopped, Strip, shortAddress } from '../send/send-ui';

type Phase =
  | { at: 'planning' }
  | { at: 'move'; plan: DepositPlan }
  | { at: 'moving' }
  | { at: 'pay'; plan: DepositPlan }
  | { at: 'paying' }
  | { at: 'stopped'; error: string }
  /** the price ran out: before anything moved, or with the zec already on the swap's address */
  | { at: 'expired'; moved: boolean };

/** a shield-out confirms in a block or two; asking the light client is all this costs */
const MOVED_POLL_MS = 15_000;

/**
 * How much of the price's life the move needs: build, a block or two (75 s
 * apart on average, often longer) and the poll. THORNode's ZEC quotes live
 * about 15 minutes (890 s measured live, 2026-10-04), so a price with less
 * than this left is asked again before any zec leaves the shielded pool.
 */
export const MOVE_NEEDS_MS = 6 * 60_000;

/** true when the price can't outlast the move: ask again before moving */
export const tooLateToMove = (expiresAt: number | undefined, now = Date.now()): boolean =>
  !!expiresAt && expiresAt - now < MOVE_NEEDS_MS;

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
  swapT,
  onSent,
  onBack,
  onExpired,
  onShield,
}: {
  quote: Quote;
  amountZat: bigint;
  /** the swap's own transparent address, claimed when it was confirmed */
  swapT: SwapTAddress;
  onSent: (txid: string) => void;
  onBack: () => void;
  /** ask a fresh price; the swap keeps its address, so moved zec is used as it is */
  onExpired: () => void;
  /** take the moved zec back into the shielded pool instead */
  onShield: () => void;
}) => {
  const tAddress = swapT.address;
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const walletId = keyInfo?.id;
  const zcashWallet = useStore(selectActiveZcashWallet);
  // a zigner wallet signs on the device; the viewing key builds what it signs
  const cold = !!keyInfo && walletKind(keyInfo, zcashWallet) === 'zigner';
  const ufvk =
    zcashWallet?.ufvk ??
    (zcashWallet?.orchardFvk?.startsWith('uview') ? zcashWallet.orchardFvk : undefined);
  const storeId = useStore(activeZcashStoreId) ?? walletId;
  const pocket = useStore(activeAccountIndex);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const ironwood = usePoolNotes(storeId).ironwood;
  const { requestAuth, PasswordModal } = usePasswordGate();
  const [phase, setPhase] = useState<Phase>({ at: 'planning' });
  const [moved, setMoved] = useState(false);
  // the device round on screen (cold only); stepping back from it cancels the round
  const round = useMemo(
    () =>
      createZignerRound((pczt, json) =>
        applySignatureContributionsInWorker(
          'zcash',
          storeId!,
          pczt,
          JSON.parse(json) as SignatureContribution[],
        ),
      ),
    [storeId],
  );
  const shown = useZustand(round.store, s => s.shown);
  useEffect(() => () => void round.cancel(), [round]);

  const req = {
    tAddress,
    tIndex: swapT.index,
    to: quote.depositAddress,
    amountZat: amountZat.toString(),
    memo: quote.memo ?? '',
    mainnet: true,
  };

  // price the deposit from the address's coins, and again while a move confirms
  useEffect(() => {
    if (phase.at !== 'planning' && phase.at !== 'moving') {
      return;
    }
    let live = true;
    // the vault is checked first: nothing moves toward a deposit that could never be paid
    const ask = () =>
      checkVault(req.to, req.mainnet)
        .then(() => planTransparentDepositInWorker(zidecarUrl, req))
        .then(
          plan => {
            if (!live || (plan.short !== '0' && phase.at !== 'planning')) {
              return;
            }
            // a move this price can't outlast is never offered
            setPhase(
              plan.short === '0'
                ? { at: 'pay', plan }
                : tooLateToMove(quote.expiresAt)
                  ? { at: 'expired', moved: false }
                  : { at: 'move', plan },
            );
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

  /**
   * Run one confirmed step: a hot wallet unlocks and signs here, a zigner one
   * on the device. Stepping back from the device goes back to its review.
   */
  const step = async (
    busy: { at: keyof typeof SHORT },
    review: Phase,
    run: { hot: (vault: VaultUnlock) => Promise<void>; cold: (ufvk: string) => Promise<void> },
  ) => {
    if (!walletId || (!cold && !(await requestAuth()))) {
      return;
    }
    setPhase(busy);
    try {
      if (cold) {
        if (!ufvk) {
          throw new Error('this zigner wallet has no viewing key here · please re-import it');
        }
        await run.cold(ufvk);
      } else {
        await run.hot(await getVaultUnlock(walletId));
      }
    } catch (e) {
      if (isZignerDeclined(e)) {
        setPhase(review);
        return;
      }
      const line = lineOf(e);
      setPhase({ at: 'stopped', error: /insufficient/i.test(line) ? SHORT[busy.at] : line });
    }
  };

  const move = (plan: DepositPlan) => {
    // the review may have sat open: the price must still outlast the move
    if (tooLateToMove(quote.expiresAt)) {
      setPhase({ at: 'expired', moved: false });
      return;
    }
    return step(
      { at: 'moving' },
      { at: 'move', plan },
      {
        hot: async vault => {
          await buildSendTxInWorker(
            'zcash',
            storeId!,
            zidecarUrl,
            tAddress,
            plan.short,
            '',
            pocket,
            true,
            vault,
          );
          setMoved(true);
        },
        // an ordinary zigner send to the swap's address, over the module envelope
        cold: async key => {
          const built = await buildSendTxPcztInWorker(
            'zcash',
            storeId!,
            zidecarUrl,
            tAddress,
            plan.short,
            '',
            0,
            true,
            key,
            false,
            undefined,
            undefined,
            true,
          );
          await signAndBroadcast(round.signer(built, 'move zec to the swap address'), built, {
            walletId: storeId!,
            zidecarUrl,
            mainnet: true,
          });
          setMoved(true);
        },
      },
    );
  };

  const pay = (plan: DepositPlan) => {
    // the zec is on the swap's address by now: say so, and let the person choose
    if (quote.expiresAt && quote.expiresAt <= Date.now()) {
      setPhase({ at: 'expired', moved: true });
      return;
    }
    const reviewed = { ...req, reviewedFee: plan.fee };
    return step(
      { at: 'paying' },
      { at: 'pay', plan },
      {
        hot: async vault => {
          const { txid } = await sendTransparentDepositInWorker(
            storeId!,
            zidecarUrl,
            reviewed,
            vault,
          );
          onSent(txid);
        },
        // the same reviewed bytes, signed on the device, checked here before broadcast
        cold: async key => {
          const ask = await buildColdDepositInWorker(storeId!, zidecarUrl, reviewed, key);
          const signed = await round.sign(ask, 'the swap deposit');
          const { txid } = await completeColdDepositInWorker(
            storeId!,
            zidecarUrl,
            reviewed,
            key,
            ask.pcztHex,
            signed,
          );
          onSent(txid);
        },
      },
    );
  };

  // a step waiting on the device: its qr, then the camera for zigner's answer
  if (shown) {
    return (
      <div className='flex h-full flex-col bg-canvas'>
        <ScreenHeader
          title='sign on zigner'
          onBack={() => round.cancel()}
          meta={phase.at === 'moving' ? '1 / 2' : moved ? '2 / 2' : undefined}
        />
        <Strip>
          <Sensitive>
            {phase.at === 'moving'
              ? `${shown.label} · ${shortAddress(tAddress)}`
              : `${shown.label} · ${zec(amountZat)} zec`}
          </Sensitive>
        </Strip>
        <Main className='items-center gap-4 px-5 pt-6'>
          <ZignerRoundView round={round} />
        </Main>
      </div>
    );
  }

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

  if (phase.at === 'expired') {
    return (
      <div className='flex h-full flex-col bg-canvas'>
        <ScreenHeader title='the price ran out' onBack={onBack} />
        <Strip>
          <Sensitive>{`${zec(amountZat)} zec · ${shortAddress(quote.depositAddress)}`}</Sensitive>
        </Strip>
        <Main className='pt-5'>
          <StatusSlot tone='info' icon='i-ph-clock'>
            {phase.moved
              ? `the zec now sits on this swap's transparent address, ${shortAddress(tAddress)} · nothing went to the vault`
              : 'nothing was moved · a fresh price is a tap away'}
          </StatusSlot>
        </Main>
        <Footer>
          {phase.moved ? (
            <>
              <Button variant='secondary' onClick={onShield} className='grow'>
                shield it back
              </Button>
              <Button onClick={onExpired} className='grow'>
                swap again
              </Button>
            </>
          ) : (
            <>
              <Button variant='secondary' onClick={onBack} className='w-[110px]'>
                back
              </Button>
              <Button onClick={onExpired} className='grow'>
                get a new price
              </Button>
            </>
          )}
        </Footer>
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
          lead="to this swap's own transparent address"
          amount={zec(phase.plan.short)}
          unit='zec'
          rows={[
            [
              'to',
              <span key='to' className='font-mono'>
                {shortAddress(tAddress)}
              </span>,
            ],
            ['fee', <Sensitive key='fee'>{`${zec(fee)} zec`}</Sensitive>],
            ['then', 'the swap, reviewed next'],
            // two device rounds: this move, and the deposit after it confirms
            ...(cold ? ([['zigner', 'signs this move, then the swap']] as const) : []),
          ]}
          privacy='public · the amount and your address show'
          confirm={cold ? 'move zec · sign with zigner' : 'move zec'}
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
                {shortAddress(tAddress)}
              </span>,
            ],
          ]}
          confirm={cold ? 'sign with zafu zigner' : 'confirm and send'}
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
      : "moving zec to this swap's transparent address",
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
