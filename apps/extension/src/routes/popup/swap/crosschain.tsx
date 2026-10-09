/**
 * Swap zec with another chain over whichever route carries it (board Swap).
 * The form opens filled (the last pair, 10% of the zec out, your address on
 * the other side) and prices arrive as it is typed: every allowed route is
 * asked, the best so far leads, and a route that can't quote says why in one
 * quiet line. A firm quote is asked for only at review, before anything is
 * signed or shown to pay.
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { LP_PRELOAD, openLpPage } from '../../../lp/open';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { queryOptions, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@repo/ui/lib/utils';
import { localExtStorage } from '@repo/storage-chrome/local';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { StepList } from '@repo/ui/components/ui/step-list';
import { Sensitive } from '../../../components/sensitive';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetVaultUnlock } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { zcashViewKey } from '../../../state/zcash-view-key';
import { activeAccountIndex, activeZcashStoreId } from '../../../state/pockets';
import { CAPS, walletKind } from '../../../signing/wallet-kind';
import { isEgressBlocked, refreshEgress } from '../../../net/egress';
import { requestEgressOptIn } from '../../../net/egress-opt-in';
import { setDestinationOptIn } from '../../../net/ledger';
import { EgressBlockedStatus } from '../../../shared/components/egress-blocked-status';
import { useActiveAddress } from '../../../hooks/use-address';
import { useSwapTAddress, type SwapTAddress } from '../../../hooks/use-transparent-addresses';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { useSwapLast, useSwapRoutes } from '../../../hooks/swap-routes';
import { swapWallet } from '../../../hooks/swap-preload';
import { keepSwapPreload, keepSwapQuotes, seedSwapQuotes } from '../../../state/swap/preload';
import {
  forgetOpenSwap,
  openSwapOf,
  patchOpenSwap,
  quoteOf,
  readOpenSwaps,
  saveOpenSwap,
  STAGE_FOR,
  type OpenSwap,
} from '../../../state/swap/open-swaps';
import { usePasswordGate } from '../../../hooks/password-gate';
import {
  buildSendTxInWorker,
  completeSendTxInWorker,
  planTransparentDepositInWorker,
} from '../../../state/keyring/network-worker';
import { checkVault, type DepositPlan } from '../../../workers/transparent-deposit';
import { legContextOf, resumeSwapLegs, runSwapLegs } from '../../../state/swap/thor-legs';
import { openSwapUnlock, stopThorOut, tooLateToMove } from '../../../state/swap/thor-out';
import type { VaultUnlock } from '../../../state/keyring/types';
import { EMPTY_POOL_NOTES, usePoolNotes } from '../../../hooks/zcash-pool-balances';
import { maxSendable, quoteSend } from '../send/spendable';
import { PROVIDERS, routeTokens } from '../../../state/swap';
import {
  figure,
  fromUnits,
  lead,
  rank,
  toUnits,
  type Quote,
  type QuoteRequest,
  type SwapPhase,
  type SwapStatusView,
  type SwapToken,
} from '../../../state/swap/provider';
import { BelowMinimum } from '../../../state/swap/thornode';
import {
  chips,
  DEBOUNCE_MS,
  defaultAmount,
  egressViewQuery,
  gates,
  lastOfPair,
  pairOf,
  plain,
  QUOTABLE,
  quoteQuery,
  quoteStatus,
  refreshIn,
  SWAP_EGRESS,
  WAIT,
  watchEgress,
  type Gate,
} from '../../../state/swap/live';
import { NeedsRefundAddress } from '../../../state/swap/near';
import {
  asksCustody,
  isRouteId,
  pairKey,
  ROUTES,
  routeLabel,
  poolAsset,
  refundsToPayer,
  type MemoCarrier,
  type RouteId,
  type SwapPair,
} from '../../../state/swap/routes';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import {
  encodeZcashSignRequest,
  parseZcashSignatureResponse,
  isZcashSignatureQR,
  hexToBytes,
  bytesToHex,
} from '@repo/wallet/networks';
import { useBackNav, usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { looksLikeLink, toUri } from '../../../links/router';
import { viaLine, type SwapLinkState } from '../../../links/land';
import { Addr, Footer, Main } from '../send/send-ui';
import { ThorOutTracker } from './thor-deposit';
import { DepositCard, untilLabel } from './deposit-card';
import { AmountField, AddressSheet, ToField } from '../send/send-fields';
import { chainLabel, chainOfSwap, isAddressOn } from '../../../addresses/kind';
import { useYourAddresses } from '../../../hooks/use-your-addresses';
import { chainName } from '../../../state/swap/tokens';
import { TokenSheet } from './token-sheet';
import { BuyCashRow } from '../../../components/buy-cash-row';
import { CashOutRow, PeerCashOutNote } from '../../../components/cash-out-row';
import { isCashOutToken } from '../../../config/ramps';
import { CostList, CostMeta } from './cost-lines';
import './swap-live.css';

export type Step =
  | 'input'
  | 'thor-out'
  | 'sign'
  | 'scan'
  | 'sending'
  | 'deposit'
  | 'polling'
  | 'done'
  | 'refunded'
  | 'error';

/** where a watched swap goes on each status; a refund is its own calm end, never the error step */
export const STEP_FOR: Partial<Record<SwapPhase, Step>> = {
  processing: 'polling',
  done: 'done',
  refunded: 'refunded',
  failed: 'error',
};

/** a refund is a normal outcome: the money is safe, and nothing here invites a second swap */
export const RefundedSlot = ({ line }: { line?: string }) => (
  <StatusSlot tone='info' icon='i-ph-arrow-u-up-left'>
    {line}
  </StatusSlot>
);

/**
 * The worker build for a zcash deposit, the one call every signer shares: the
 * chosen pocket's store and account, never the wallet's pocket 0. A hot wallet
 * passes its vault (signed and broadcast), a cold one its ufvk (unsigned).
 */
export const buildDeposit = (o: {
  storeId?: string;
  walletId: string;
  pocket: number;
  zidecarUrl: string;
  to: string;
  amountIn: string;
  vault?: VaultUnlock;
  ufvk?: string;
}) =>
  buildSendTxInWorker(
    'zcash',
    o.storeId ?? o.walletId,
    o.zidecarUrl,
    o.to,
    toUnits(o.amountIn, 8).toString(),
    '',
    o.pocket,
    true,
    o.vault,
    o.ufvk,
  );

/** the one note under the routes, per route and direction */
const NOTE: Record<RouteId, Record<SwapPair['direction'], string>> = {
  near: {
    into_zec: 'a third-party solver holds your funds during the swap. it can delay or freeze them.',
    from_zec: 'a third-party solver holds your zec during the swap. it can delay or freeze it.',
  },
  thor: {
    into_zec:
      "thorchain pays transparent addresses only. the zec lands at this swap's own t-address, ready to shield.",
    from_zec: 'leaves the shielded pool through your transparent address. that step is public.',
  },
  penumbra: { into_zec: '', from_zec: '' },
};

/** into zec on a route that refunds the payer: the one honest line in place of a refund address */
const PAYER_REFUNDS = "refunds go back to the address that pays · don't pay from an exchange";

const MEMO_HOW: Record<MemoCarrier, string> = {
  op_return: 'add it to the payment as an op_return output, exactly as shown',
  memo: "put it in the payment's memo field, exactly as shown",
};

function LiveTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => setElapsed(Math.round((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);
  return <div className='font-mono text-2xl tabular-nums text-zigner-gold'>{elapsed}s</div>;
}

/** a typed value once it has rested for a moment and is usable; the last usable one meanwhile */
export const useSettled = (value: string, usable: boolean) => {
  const [settled, setSettled] = useState(usable ? value : undefined);
  useEffect(() => {
    if (!usable || value === settled) {
      return;
    }
    const t = setTimeout(() => setSettled(value), settled ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [value, usable, settled]);
  return settled;
};

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** the time to the next price, as a thin ring draining (no ticking renders) */
const Drain = ({ at }: { at: number }) => (
  <svg viewBox='0 0 12 12' className='size-3 -rotate-90' aria-hidden='true'>
    <circle
      key={at}
      cx='6'
      cy='6'
      r='5'
      fill='none'
      strokeWidth='1.5'
      strokeDasharray='31.4'
      className='swap-drain stroke-zigner-gold/60'
      style={{ '--over': `${Math.max(0, at - Date.now())}ms`, '--len': '31.4' } as CSSProperties}
    />
  </svg>
);

/** a figure that fades in when it changes, and dims while a newer one is asked for */
const Figure = ({ text, stale, struck }: { text: string; stale?: boolean; struck?: boolean }) => (
  <span className={cn('transition-opacity duration-300', stale && 'opacity-50')}>
    <Sensitive
      key={text}
      className={cn(
        'duration-300 animate-in fade-in motion-reduce:animate-none',
        struck && 'line-through',
      )}
    >
      {text}
    </Sensitive>
  </span>
);

/** the amount you get, counting from the last figure to the new one */
const CountUp = ({ text }: { text: string }) => {
  const [between, setBetween] = useState<string>();
  const from = useRef(text);
  useEffect(() => {
    const [a, b] = [parseFloat(from.current), parseFloat(text)];
    from.current = text;
    if (!(a > 0 && b > 0) || a === b || calm()) {
      return;
    }
    const places = text.split('.')[1]?.length ?? 0;
    const t0 = performance.now();
    let frame = requestAnimationFrame(function tick(t) {
      const k = Math.min(1, (t - t0) / 250);
      setBetween(k < 1 ? (a + (b - a) * (1 - (1 - k) ** 3)).toFixed(places) : undefined);
      frame = k < 1 ? requestAnimationFrame(tick) : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return <Sensitive>{between ?? text}</Sensitive>;
};

/** the amount the swap pays out, counting up to each new price */
const YouGet = ({ view, stale, struck }: { view?: Quote; stale: boolean; struck: boolean }) => (
  <span className='min-w-0 truncate font-display text-2xl text-fg-high'>
    {view ? (
      <span
        className={cn(
          'transition-opacity duration-300',
          stale && 'opacity-50',
          struck && 'line-through',
        )}
      >
        <CountUp text={view.amountOutText} />
      </span>
    ) : (
      <span className='text-fg-dim'>0</span>
    )}
  </span>
);

/** rows glide from where they were when their order changes (FLIP), instead of jumping */
const useFlip = (list: RefObject<HTMLElement | null>, order: string) => {
  const was = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    for (const row of list.current?.children ?? []) {
      const { key = '' } = (row as HTMLElement).dataset;
      const top = (row as HTMLElement).offsetTop;
      const before = was.current.get(key);
      if (before !== undefined && before !== top && !calm()) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], {
          duration: 200,
          easing: 'ease-out',
        });
      }
      was.current.set(key, top);
    }
  }, [list, order]);
};

/** one route in the routes sheet: a square mark, name, amount, one meta line */
const RouteChoice = ({
  quote,
  unit,
  on,
  best,
  more,
  decimals,
  onPick,
}: {
  quote: Quote;
  unit: string;
  decimals: number;
  on: boolean;
  best: boolean;
  /** how much more than the next route, on the best one */
  more?: string;
  onPick: () => void;
}) => (
  <button
    type='button'
    onClick={onPick}
    disabled={!!quote.notYet}
    aria-pressed={on}
    className={cn(
      'flex w-full flex-col gap-2 border px-4 py-3.5 text-left transition-colors',
      on ? 'border-zigner-gold bg-zigner-gold/10' : 'border-border-soft bg-elev-1',
      quote.notYet ? 'cursor-default opacity-70' : 'hover:border-border-hard',
    )}
  >
    <span className='flex items-center gap-3'>
      <span
        className={cn(
          'grid size-4 shrink-0 place-items-center border',
          on ? 'border-zigner-gold' : 'border-border-hard',
        )}
      >
        {on && <span className='size-2 bg-zigner-gold' />}
      </span>
      <span className='grow text-sm text-fg-high'>{routeLabel(quote.route, best)}</span>
      <span className='text-sm text-fg-high'>
        <Figure text={`${quote.amountOutText} ${unit}`} />
      </span>
    </span>
    <span className='flex flex-wrap gap-x-3 pl-7 text-[11px] text-fg-muted'>
      <RouteMeta quote={quote} unit={unit} decimals={decimals} more={more} />
    </span>
  </button>
);

const RouteMeta = ({
  quote,
  unit,
  decimals,
  more,
}: {
  quote: Quote;
  unit: string;
  decimals: number;
  more?: string;
}) => (
  <>
    {quote.timeText && <span>{quote.timeText}</span>}
    {quote.atLeastText && <span>{`at least ${quote.atLeastText} ${unit}`}</span>}
    {more && (
      <span>
        <Sensitive className='text-success'>{`${more} ${unit}`}</Sensitive> more
      </span>
    )}
    {quote.cost && <CostMeta cost={quote.cost} unit={unit} decimals={decimals} />}
    <span
      className={
        quote.notYet ? 'text-fg-muted' : quote.route === 'near' ? 'text-warn' : 'text-success'
      }
    >
      {quote.notYet ?? ROUTES[quote.route].custody}
    </span>
  </>
);

/**
 * One route on one line: its name, then its price or why it has none. While
 * its request is out, a thin gold line fills over the route's real wait.
 */
/**
 * A route's line, tapped: one turned down at the first ask is asked again only
 * on its own tap; one the person turned off is turned on at once, and the
 * screen asks it once the egress view changes (watchEgress).
 */
const TAP: Record<NonNullable<Gate['tap']>, (egress: string) => Promise<unknown>> = {
  ask: requestEgressOptIn,
  'turn-on': egress => setDestinationOptIn(egress, 'allowed').then(refreshEgress),
};

const RouteLine = ({
  route,
  line,
  on,
  waiting,
  stale,
  onPress,
}: {
  route: RouteId;
  line?: string;
  on?: boolean;
  waiting?: boolean;
  /** an older price, kept while the next is asked */
  stale?: boolean;
  onPress?: () => void;
}) => {
  const wait = WAIT[route];
  return (
    <button
      type='button'
      data-key={route}
      onClick={onPress}
      disabled={!onPress}
      className={cn(
        'relative flex h-6 min-w-0 shrink-0 items-center text-left text-[11px]',
        on ? 'text-fg-high' : 'text-fg-muted',
        onPress ? 'underline-offset-4 hover:text-fg-high hover:underline' : 'cursor-default',
      )}
    >
      <Clipped>
        {ROUTES[route].label}
        {line && (
          <span
            key={line}
            className={cn(
              'transition-opacity duration-300 animate-in fade-in motion-reduce:animate-none',
              stale && 'opacity-50',
            )}
          >
            &nbsp;· {line}
          </span>
        )}
      </Clipped>
      {waiting && wait && (
        <span
          className='swap-wait absolute inset-x-0 bottom-0.5 h-px bg-zigner-gold'
          style={{ '--after': `${wait.after}ms`, '--over': `${wait.over}ms` } as CSSProperties}
        />
      )}
    </button>
  );
};

/** a thorchain route this costs more than 5% against the market: its pool is thin */
const DEEPEN_BPS = 500;

/** "deepen this pool": opens lp.html, the zec liquidity page */
const DeepenLink = () => (
  <button
    type='button'
    data-preload={LP_PRELOAD}
    onClick={openLpPage}
    className='flex h-6 shrink-0 items-center gap-1 text-[11px] text-fg-muted hover:text-fg-high'
  >
    deepen this pool
    <span className='i-lucide-arrow-up-right size-2.5 text-fg-dim' aria-hidden='true' />
  </button>
);

/** what a thorchain deposit from the swap's own address costs, and what that address is short */
const depositPlanQuery = (zidecarUrl: string, t?: SwapTAddress, q?: Quote, amountIn = '') =>
  queryOptions({
    queryKey: ['swap-deposit-plan', t?.address, q?.depositAddress, q?.memo, amountIn],
    queryFn: async (): Promise<DepositPlan> => {
      const req = {
        tAddress: t!.address,
        tIndex: t!.index,
        to: q!.depositAddress,
        amountZat: toUnits(amountIn, 8).toString(),
        memo: q!.memo ?? '',
        mainnet: true,
      };
      // the vault is checked first: nothing is reviewed toward a deposit that could never be paid
      await checkVault(req.to, req.mainnet);
      return planTransparentDepositInWorker(zidecarUrl, req);
    },
    staleTime: 60_000,
    retry: false,
  });

const samePlan = (a?: DepositPlan, b?: DepositPlan) => a?.fee === b?.fee && a?.short === b?.short;

const zecOf = (zat: string | bigint) => fromUnits(BigInt(zat), 8);

/** the custodial routes the person acknowledged, each once */
const custodyAckQuery = queryOptions({
  queryKey: ['swapCustodyAck'],
  queryFn: async (): Promise<RouteId[]> =>
    ((await localExtStorage.get('swapCustodyAck')) ?? []).filter(isRouteId),
});

/** where a remembered swap reopens */
const stepOf = (s: OpenSwap): Step =>
  s.stage === 'thor-out'
    ? 'thor-out'
    : s.stage === 'deposit'
      ? s.direction === 'into_zec'
        ? 'deposit'
        : 'polling'
      : s.stage === 'sent'
        ? 'polling'
        : s.stage === 'failed'
          ? 'error'
          : s.stage;

/** the swap asks for its routes once per popup: a "not now" waits for the next open */
let askedRoutes = false;

export const CrosschainSwap = ({
  link,
  resume,
}: {
  link?: SwapLinkState;
  /** an open swap's id: the screen reopens it where it stood */
  resume?: string;
}) => {
  const goBack = useBackNav(PopupPath.INDEX);
  const navigate = usePopupNav();
  const queryClient = useQueryClient();
  const { address: zcashAddress } = useActiveAddress();
  // a thorchain swap's own transparent address: a look for prices, claimed on confirm
  const swapTNext = useSwapTAddress(true, queryClient);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const storeId = useStore(activeZcashStoreId);
  const pocket = useStore(activeAccountIndex);
  const wallet = useStore(swapWallet);
  const kind = selectedKeyInfo && walletKind(selectedKeyInfo, activeZcashWallet);
  const ufvk = zcashViewKey(activeZcashWallet);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const { chosen, choose } = useSwapRoutes();
  const { last, read, remember } = useSwapLast(wallet);
  // one ask, on the first open, for everything the swap talks to; once allowed, never again
  useEffect(() => {
    if (!askedRoutes) {
      askedRoutes = true;
      void requestEgressOptIn(SWAP_EGRESS);
    }
  }, []);

  const pinned = link?.link.route;
  const [step, setStep] = useState<Step>('input');
  // what the user chose; anything left undefined is derived from defaults below
  const [pickedDirection, setDirection] = useState(link?.link.direction);
  const [pickedToken, setToken] = useState<SwapToken>();
  const [typedAmount, setAmount] = useState(link?.link.amount);
  const [typedAddress, setAddress] = useState(link?.link.address);
  // a link names its token by symbol: the picker opens (its list is the
  // fetch the egress sheet asks about) and picks it once the list is here
  const [linkToken, setLinkToken] = useState(link?.link);
  const [pickerOpen, setPickerOpen] = useState(!!link);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [picked, setPicked] = useState<RouteId>();
  // the price review froze, with the request it answered (amount, addresses) frozen beside
  // it: the deposit is built from that request, never the live form. once confirm
  // re-checked it, `was` holds the price it replaced
  const [firm, setFirm] = useState<{
    quote: Quote;
    req: QuoteRequest;
    was?: Quote;
    checked?: true;
  }>();
  // the fresh t-address this swap claimed (thorchain); kept across a backed-out
  // review or an expired price so a retry reuses it, dropped once the swap ends
  const [swapT, setSwapT] = useState<SwapTAddress>();
  // the sealed record of the swap in flight (state/swap/open-swaps); every step writes it
  const openId = useRef<string>(undefined);
  const track = (patch: Partial<OpenSwap>) => {
    if (openId.current) {
      void patchOpenSwap(openId.current, patch);
    }
  };
  /** the swap ended here, or the person let it go: home stops showing it */
  const forget = () => {
    if (openId.current) {
      stopThorOut(openId.current);
      void forgetOpenSwap(openId.current);
    }
    openId.current = undefined;
  };
  // a remembered swap reopens where it stood; nothing is asked of the network to find it
  const [resuming, setResuming] = useState(!!resume);
  useEffect(() => {
    if (!resume) {
      return;
    }
    void readOpenSwaps().then(list => {
      const o = list.find(x => x.id === resume);
      setResuming(false);
      if (!o) {
        return;
      }
      openId.current = o.id;
      setDirection(o.direction);
      setToken(o.token);
      setSwapT(o.swapT);
      setDepositTxid(o.depositTxid);
      setFirm({
        quote: quoteOf(o),
        req: {
          direction: o.direction,
          token: o.token,
          amountIn: o.amountIn,
          zcashAddress: o.direction === 'into_zec' ? o.recipient : '',
          otherAddress: o.otherAddress,
          zcashTransparent: o.swapT?.address,
        },
        checked: true,
      });
      if (o.line) {
        setStatus({ phase: o.stage === 'failed' ? 'failed' : 'waiting', line: o.line });
        if (o.stage === 'failed') {
          setError(o.line);
        }
      }
      if (o.stage === 'thor-out' && !o.depositFee) {
        // reviewed before both legs were one: priced again from the form, its address (and zec) kept
        forget();
        setStep('input');
        return;
      }
      setStep(stepOf(o));
      resumeSwapLegs(o, useStore.getState());
    });
  }, [resume]);
  const [checking, setChecking] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [custodyOpen, setCustodyOpen] = useState(false);
  const [status, setStatus] = useState<SwapStatusView>();
  const [depositTxid, setDepositTxid] = useState<string>();
  const [error, setError] = useState<string>();
  // kept alongside the message so a blocked destination can offer an inline allow
  const [errorCause, setErrorCause] = useState<unknown>();
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const unsignedTxRef = useRef<any | null>(null);
  const [sendSteps, setSendSteps] = useState<
    { step: string; detail?: string; elapsedMs: number }[]
  >([]);
  const buildStartRef = useRef(0);

  // the spending pocket's own pool (as thor-deposit); nothing shows before its notes are read
  const pool = usePoolNotes(storeId ?? selectedKeyInfo?.id);
  const { ironwood } = pool;
  const notes = useMemo(() => ironwood.filter(n => !n.spent).map(n => BigInt(n.value)), [ironwood]);
  const balanceZec = notes.length
    ? fromUnits(
        notes.reduce((a, v) => a + v, 0n),
        8,
      )
    : undefined;
  // every note, the real ZIP-317 fee, priced as the dearer transparent output: the deposit
  // address isn't known yet. thorchain's two-step pays a second fee (its own screen checks)
  const maxZat = maxSendable(notes, { transparentRecipient: true }).amountZat;

  // with no pair remembered, the direction waits for the balance, so it never flips under the person
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 1500);
    return () => clearTimeout(t);
  }, []);
  const settled = read && (pool !== EMPTY_POOL_NOTES || waited);
  const remembered = pickedDirection ?? last?.direction;
  const decided = !!remembered || settled;
  const direction = remembered ?? (notes.length || !settled ? 'from_zec' : 'into_zec');
  const token = pickedToken ?? (link ? undefined : last?.token);
  const isFromZec = direction === 'from_zec';
  const pair: SwapPair | undefined = token && pairOf({ direction, token });
  const key = pair && pairKey(pair);
  const pinnedRefusal = pinned && pair ? ROUTES[pinned].refuses(pair) : undefined;
  const unit = token?.symbol.toLowerCase() ?? 'select';
  const outUnit = isFromZec ? unit : 'zec';
  const inUnit = isFromZec ? 'zec' : unit;
  const outDecimals = isFromZec ? (token?.decimals ?? 8) : 8;
  const amountIn = typedAmount ?? defaultAmount(direction, maxZat, token);
  const overMax = isFromZec && toUnits(amountIn, 8) > maxZat;
  const quick = isFromZec ? chips(maxZat) : [];

  // the chain the other address is on; the picker and "yours" follow it
  const fieldChain = chainOfSwap(token?.chain);
  const { yours, remember: rememberYours } = useYourAddresses(fieldChain);
  const otherAddress = (typedAddress ?? yours[0]?.address ?? '').trim();
  const fits = (a: string) => (fieldChain ? isAddressOn(a, fieldChain) : !!a);
  // your refund address, offered to "yours" the first time it is used
  const [rememberIt, setRememberIt] = useState(true);
  const otherValid = !!fieldChain && isAddressOn(otherAddress, fieldChain);
  const known = yours.some(y => y.address === otherAddress);

  // what the routes are asked: a default at once, a typed value once it rests
  const settledAmount = useSettled(amountIn, parseFloat(amountIn) > 0);
  const settledAddress = useSettled(otherAddress, fits(otherAddress));
  const askAmount = typedAmount === undefined ? amountIn : settledAmount;
  const askAddress = typedAddress === undefined ? otherAddress : settledAddress;
  const signsOpReturn = !!kind && !!CAPS[kind].opReturn;
  // thorchain pays (and refunds) a t-address: each swap its own, never the pocket's shown one
  const zcashTransparent = swapT?.address ?? swapTNext.next?.address;
  // into zec from an OP_RETURN chain, thorchain refunds the payer: it needs no address typed
  const addressOptional = !isFromZec && !!pair && refundsToPayer('thor', pair);
  const usable =
    parseFloat(askAmount ?? '') > 0 && (askAddress ? fits(askAddress) : addressOptional);
  const req = useMemo<QuoteRequest | undefined>(
    () =>
      decided && token && zcashAddress && usable
        ? {
            direction,
            token,
            amountIn: askAmount!,
            zcashAddress,
            zcashTransparent,
            otherAddress: askAddress ?? '',
            signsOpReturn,
            // out of zec, the send to the deposit pays its own ZIP-317 fee: part of the cost
            sourceFeeZat: isFromZec
              ? String(
                  quoteSend(notes, toUnits(askAmount!, 8), { transparentRecipient: true }).feeZat,
                )
              : undefined,
          }
        : undefined,
    [
      direction,
      token,
      zcashAddress,
      usable,
      askAmount,
      askAddress,
      zcashTransparent,
      signsOpReturn,
      isFromZec,
      notes,
    ],
  );
  const typing = amountIn !== askAmount || otherAddress !== askAddress;

  // every route for the pair: allowed ones are asked, the rest say why in one line
  const egress = useQuery(egressViewQuery).data;
  const gated = pair && egress && !pinnedRefusal ? gates(pair, egress, pinned) : [];
  const asked = req && wallet ? gated.filter(g => !g.line) : [];
  const answers = useQueries({
    queries: asked.map(({ route }) => {
      const q = quoteQuery(route, wallet!, req!);
      return {
        ...q,
        // the last price of this pair stays, dimmed, while the next amount is asked
        placeholderData: () => lastOfPair(queryClient, q.queryKey),
        // the review holds its own firm quote; nothing is asked behind it
        enabled: step === 'input' && !reviewOpen,
      };
    }),
  });
  const quotes = rank(answers.flatMap(a => (a.data ? [a.data] : [])));
  const best = quotes.find(q => !q.notYet);
  const live = (id?: RouteId) => quotes.find(q => q.route === id && !q.notYet);
  const quote = live(picked) ?? live(key ? chosen[key] : undefined) ?? best;
  const view = quote ?? quotes[0];
  // the route the person is looking at; into zec, it decides whether a refund address means anything
  const focusRoute = picked ?? (key ? chosen[key] : undefined) ?? view?.route;
  const payerRefunds = !!pair && refundsToPayer(focusRoute, pair);
  const answerOf = (id?: RouteId) => answers[asked.findIndex(g => g.route === id)];
  const shown = answerOf(view?.route);
  const stale = typing || !!shown?.isPlaceholderData || !!shown?.isFetching;
  const fetching = answers.some(a => a.isFetching);
  const expiredLive = !!view?.expiresAt && view.expiresAt <= Date.now();
  const reviewable =
    !!quote && !typing && !overMax && !answerOf(quote.route)?.isPlaceholderData && !expiredLive;
  const ahead = lead(quotes);
  const more = ahead ? figure(ahead, outDecimals) : undefined;
  // the routes with no price: refused, failed, blocked or not asked yet
  const quiet = [
    ...asked.flatMap((g, i) => {
      const a = answers[i];
      return a && !a.data && a.error ? [{ route: g.route, line: plain(g.route, a.error) }] : [];
    }),
    ...gated.flatMap(g => (g.line ? [{ ...g, line: g.line }] : [])),
  ];
  const below = answers.find(a => a.error instanceof BelowMinimum && !a.data)?.error;
  const allFailed =
    !!req && !quotes.length && !fetching && asked.length > 0 && quiet.length >= asked.length;
  // every route keeps its one line, best first: an arrival reorders rows, never adds or removes one
  const lines = gated
    .map(g => {
      const a = answerOf(g.route);
      const q = a?.data;
      const tap = g.tap && TAP[g.tap];
      return {
        route: g.route,
        line: q
          ? `${q.amountOutText} ${outUnit}${q.notYet ? ` · ${q.notYet}` : ''}`
          : (g.line ?? (a?.error ? plain(g.route, a.error) : undefined)),
        on: !!q && q.route === view?.route,
        waiting: !!a?.isFetching,
        stale: !!a?.isPlaceholderData || !!a?.isFetching,
        onPress: q
          ? () => setRoutesOpen(true)
          : tap
            ? () => void tap(ROUTES[g.route].egress)
            : // near wants a refund address: choosing it brings the field back
              a?.error instanceof NeedsRefundAddress
              ? () => setPicked(g.route)
              : undefined,
        rank: q ? quotes.indexOf(q) : g.line || a?.error ? 99 : 50,
        // thorchain's zec pool is thin or refusing: one quiet link to deepen it
        deepen:
          g.route === 'thor' &&
          (q
            ? q.vsMarketBps !== undefined && q.vsMarketBps <= -DEEPEN_BPS
            : !!a?.error && !(a.error instanceof BelowMinimum)),
      };
    })
    .sort((x, y) => x.rank - y.rank);
  const routeList = useRef<HTMLDivElement>(null);
  useFlip(routeList, lines.map(l => l.route).join());
  const asking = quoteStatus(
    asked.map((g, i) => ({
      route: g.route,
      out: !!answers[i]?.isFetching,
      priced: !!answers[i]?.data,
    })),
  );

  // the prices shown are kept for a reopened popup, and put back as this one opens
  useEffect(() => {
    if (!wallet) {
      return;
    }
    void seedSwapQuotes(queryClient, wallet);
    return keepSwapQuotes(queryClient, wallet);
  }, [queryClient, wallet]);
  useEffect(() => watchEgress(queryClient), [queryClient]);

  // the opening request, kept for the next swap tap to warm (only an untouched form)
  useEffect(() => {
    if (wallet && req && typedAmount === undefined && typedAddress === undefined) {
      void keepSwapPreload(wallet, req);
    }
  }, [wallet, req, typedAmount, typedAddress]);

  const deal = firm?.quote;
  // a custodial route is acknowledged once, by the first confirm through it (board SwapU-Custody)
  const custodyAcked = useQuery(custodyAckQuery).data ?? [];
  const askCustody = !!deal && asksCustody(deal.route, custodyAcked);
  // out of zec over thorchain the review shows both legs: the move to the swap's own address
  // (when it is short) and the deposit from it, priced before anything is signed
  const thorOut = !!deal?.memo && isFromZec;
  const tLook = swapT ?? swapTNext.next;
  const planAsk = useQuery({
    ...depositPlanQuery(zidecarUrl, tLook, deal, firm?.req.amountIn),
    enabled: reviewOpen && thorOut && !!tLook,
  });
  const reviewedPlan = planAsk.data;
  const moving = !!reviewedPlan && reviewedPlan.short !== '0';
  const moveFee = moving
    ? quoteSend(notes, BigInt(reviewedPlan.short), { transparentRecipient: true }).feeZat
    : 0n;
  const carrier = pair && deal && poolAsset(deal.route, pair)?.carrier;
  // the deadline in review is the price's; on the deposit screen it is the window to pay in
  const left = useDeadlineCountdown(
    reviewOpen || step === 'deposit' ? (deal?.expiresAt ?? null) : null,
  );
  // a price that can't outlast the move is asked again before any zec leaves the shielded pool
  const expired =
    reviewOpen &&
    !!deal?.expiresAt &&
    (deal.expiresAt <= Date.now() || (moving && tooLateToMove(deal.expiresAt)));
  const provider = deal && PROVIDERS[deal.route];
  const watchable =
    !!provider?.status && (deal?.watch === 'deposit' || (deal?.watch === 'txid' && !!depositTxid));

  // zcash-send-progress
  useEffect(() => {
    if (step !== 'sending') {
      return;
    }
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        step: string;
        detail?: string;
        elapsedMs: number;
      };
      setSendSteps(prev => [...prev, detail]);
    };
    window.addEventListener('zcash-send-progress', handler);
    return () => window.removeEventListener('zcash-send-progress', handler);
  }, [step]);

  // the picker's tokens, fetched only once the user opens it, never merely from opening swap
  const pickerRoutes = pinned ? [pinned] : QUOTABLE;
  const tokenQuery = useQuery({
    queryKey: ['swap-tokens', pickerRoutes],
    staleTime: 300_000,
    enabled: pickerOpen,
    queryFn: () => routeTokens(pickerRoutes),
  });
  const tokens = tokenQuery.data ?? [];
  useEffect(() => {
    if (!linkToken || !tokenQuery.data) {
      return;
    }
    const { token: symbol, chain } = linkToken;
    const t = tokenQuery.data.find(
      t => t.symbol.toLowerCase() === symbol && (!chain || t.chain === chain),
    );
    setLinkToken(undefined);
    if (t) {
      setToken(t);
      setPickerOpen(false);
    } else {
      setError(`${symbol} isn't offered for swaps right now · please pick another`);
    }
  }, [linkToken, tokenQuery.data]);

  // a new pair starts from its defaults again, and is where the screen reopens
  const choosePair = (d: SwapPair['direction'], t: SwapToken | undefined) => {
    setDirection(d);
    setToken(t);
    setAddress(undefined);
    setRememberIt(true);
    setPicked(undefined);
    setError(undefined);
    if (d !== direction || d === 'into_zec') {
      setAmount(undefined);
    }
    remember({ direction: d, token: t });
  };
  const flip = () => choosePair(isFromZec ? 'into_zec' : 'from_zec', token);
  // "cash": zec into usdc on base, the asset a peer listing sells
  const pickCashOut = () => {
    const t = tokens.find(isCashOutToken);
    if (t) {
      setToken(t);
      setPickerOpen(false);
    } else {
      setLinkToken({ direction: 'from_zec', token: 'usdc', chain: 'base' });
    }
  };
  const cashOut = isFromZec && isCashOutToken(token);

  const pickRoute = (route: RouteId) => {
    setPicked(route);
    setRoutesOpen(false);
    // remember only a change from the best route, and never over a link's pin
    if (key && !pinned) {
      void choose(key, route === best?.route ? undefined : route);
    }
  };

  // review freezes the price shown: nothing refreshes behind it, and only confirm re-checks it
  const firmAsk = useRef<AbortController>(undefined);
  const openReview = () => {
    if (reviewable && req) {
      setError(undefined);
      setFirm({ quote, req });
      setReviewOpen(true);
    }
  };
  const closeReview = () => {
    firmAsk.current?.abort();
    setReviewOpen(false);
  };
  // the first confirm asks the route for its firm quote; a moved price is shown, struck, for a second look
  const recheck = async () => {
    if (!firm) {
      return;
    }
    // the confirm that acknowledged a custodial route is remembered for it, for good
    if (askCustody) {
      const next = [...custodyAcked, firm.quote.route];
      queryClient.setQueryData(custodyAckQuery.queryKey, next);
      await localExtStorage.set('swapCustodyAck', next);
    }
    if (firm.checked) {
      return confirm(firm.quote, firm.req, swapT, reviewedPlan);
    }
    const ask = (firmAsk.current = new AbortController());
    setChecking(true);
    try {
      // a THORNode route touches a t-address: this swap claims its own before the firm price
      const t = firm.quote.route !== 'near' ? (swapT ?? (await swapTNext.claim())) : undefined;
      setSwapT(t);
      const req = t ? { ...firm.req, zcashTransparent: t.address } : firm.req;
      const got = await PROVIDERS[firm.quote.route]!.quote({ ...req, dry: false }, ask.signal);
      // out of zec over thorchain, the legs are priced again for the firm memo and the claimed address
      const plan =
        got.memo && req.direction === 'from_zec'
          ? await queryClient.fetchQuery(depositPlanQuery(zidecarUrl, t, got, req.amountIn))
          : undefined;
      if (ask.signal.aborted) {
        return;
      }
      // a moved price or moved legs get a second look; nothing is signed that wasn't shown
      if (got.amountOut !== firm.quote.amountOut || (plan && !samePlan(plan, reviewedPlan))) {
        setFirm({ quote: got, req, was: firm.quote, checked: true });
        return;
      }
      // `t` by hand: the swapT state set above is not this closure's yet
      return confirm(got, req, t, plan);
    } catch (e) {
      if (!ask.signal.aborted) {
        setReviewOpen(false);
        setErrorCause(e);
        setError(`${ROUTES[firm.quote.route].label} · ${plain(firm.quote.route, e)}`);
      }
    } finally {
      setChecking(false);
    }
  };

  /**
   * `r` is the request `d` answered: what is sent, whatever the form says by
   * now. `t` is the swap's own t-address when it claimed one.
   */
  const confirm = async (d: Quote, r: QuoteRequest, t = swapT, plan?: DepositPlan) => {
    if (!selectedKeyInfo || !wallet) {
      return;
    }
    setFirm({ quote: d, req: r, checked: true });
    setReviewOpen(false);
    setError(undefined);
    // remembered (sealed) before the deposit is shown or sent, so a closed popup loses nothing
    const remember = async (stage: OpenSwap['stage']) => {
      const o = openSwapOf(d, r, wallet, stage, t);
      openId.current = o.id;
      await saveOpenSwap(o);
    };

    // into zcash: the user pays from their other wallet; zafu shows where and watches
    if (r.direction === 'into_zec') {
      if (rememberIt && otherValid && !known && r.otherAddress === otherAddress) {
        void rememberYours(r.otherAddress).catch(() => undefined);
      }
      await remember('deposit');
      setStep('deposit');
      return;
    }
    if (d.notYet) {
      return;
    }
    // a memo deposit is never a shielded send: a t->t with an OP_RETURN from the swap's own
    // address, funded first when it is short. one unlock covers both legs
    if (d.memo) {
      const ctx = legContextOf(useStore.getState());
      if (!plan || !t || !ctx || (!ctx.cold && !(await requestAuth()))) {
        return;
      }
      const o = { ...openSwapOf(d, r, wallet, 'thor-out', t), depositFee: plan.fee };
      openId.current = o.id;
      await saveOpenSwap(o);
      if (!ctx.cold) {
        await openSwapUnlock(o.id, d.expiresAt, ctx.legsPerUnlock);
      }
      runSwapLegs(o, ctx, plan);
      setStep('thor-out');
      return;
    }

    try {
      const walletId = selectedKeyInfo.id;
      const deposit = {
        storeId,
        walletId,
        pocket,
        zidecarUrl,
        to: d.depositAddress,
        amountIn: r.amountIn,
      };
      setSendSteps([]);
      if (selectedKeyInfo.type === 'mnemonic') {
        if (!(await requestAuth())) {
          return;
        }
        buildStartRef.current = Date.now();
        setStep('sending');
        // the worker finishes the send even if the popup closes: the record goes first
        await remember('deposit');
        const result = await buildDeposit({ ...deposit, vault: await getVaultUnlock(walletId) });
        if (!('txid' in result)) {
          throw new Error(
            "the deposit didn't reach the network · please look at home before trying again",
          );
        }
        track({ stage: 'sent', depositTxid: result.txid });
        setStep('polling');
        return;
      }

      // zigner flow
      if (!ufvk) {
        throw new Error('this zigner wallet has no viewing key here · please re-import it');
      }
      buildStartRef.current = Date.now();
      setStep('sending');
      const result = await buildDeposit({ ...deposit, ufvk });
      if (!('sighash' in result)) {
        throw new Error('unexpected unsigned tx result');
      }
      unsignedTxRef.current = result;
      setSignRequestQr(
        encodeZcashSignRequest({
          accountIndex: pocket,
          sighash: hexToBytes(result.sighash),
          orchardAlphas: result.alphas.map(a => hexToBytes(a)),
          summary: `swap ${deposit.amountIn} ZEC`,
          mainnet: true,
        }),
      );
      setStep('sign');
    } catch (err) {
      console.error('[swap] send failed', err);
      // nothing was broadcast: there is no swap to come back to
      forget();
      setErrorCause(err);
      setError(
        err instanceof Error ? err.message : "the deposit didn't go through · nothing was sent",
      );
      setStep('error');
    }
  };

  const signatureScanned = async (data: string) => {
    try {
      if (!isZcashSignatureQR(data)) {
        setError("that code isn't zigner's answer · please scan again");
        setStep('error');
        return;
      }
      const sigResponse = parseZcashSignatureResponse(data);
      if (!unsignedTxRef.current || !selectedKeyInfo) {
        throw new Error('missing unsigned tx');
      }
      setStep('sending');
      if (firm && wallet) {
        const o = openSwapOf(firm.quote, firm.req, wallet, 'deposit', swapT);
        openId.current = o.id;
        await saveOpenSwap(o);
      }
      // the same pocket store the build read, so the spent notes are marked there
      const result = await completeSendTxInWorker(
        'zcash',
        storeId ?? selectedKeyInfo.id,
        zidecarUrl,
        unsignedTxRef.current.unsignedTx,
        {
          orchardSigs: sigResponse.orchardSigs.map(bytesToHex),
          transparentSigs: sigResponse.transparentSigs.map(bytesToHex),
        },
        unsignedTxRef.current.spendIndices,
        // lets the worker mark the spent inputs and record the send
        unsignedTxRef.current.coldSendId,
      );
      unsignedTxRef.current = null;
      if (!('txid' in result)) {
        throw new Error(
          "the deposit didn't reach the network · please look at home before trying again",
        );
      }
      track({ stage: 'sent', depositTxid: result.txid });
      setStep('polling');
    } catch (err) {
      console.error(err);
      forget();
      setError(
        err instanceof Error ? err.message : "the zigner send didn't finish · nothing was sent",
      );
      setStep('error');
    }
  };

  // watch the swap while the deposit is out, on routes that can be watched
  const trackedLine = useRef<string>(undefined);
  useEffect(() => {
    if ((step !== 'deposit' && step !== 'polling') || !deal || !watchable) {
      return;
    }
    const watch = provider.status!;
    const interval = setInterval(async () => {
      try {
        const next = await watch(deal, depositTxid);
        // the record learns each new line, not every poll
        if (trackedLine.current !== next.line) {
          trackedLine.current = next.line;
          // still waiting for a deposit is not "sent": an unpaid window must stay prunable
          track(
            next.phase === 'waiting'
              ? { line: next.line }
              : { line: next.line, stage: STAGE_FOR[next.phase] ?? 'sent' },
          );
        }
        setStatus(next);
        if (next.phase === 'failed') {
          setError(next.line);
        }
        const to = STEP_FOR[next.phase];
        if (to) {
          setStep(to);
        }
      } catch (err) {
        console.error('[swap-status] poll failed', err);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [step, deal, provider, watchable, depositTxid]);

  const resumeHeld = async () => {
    const o = (await readOpenSwaps()).find(x => x.id === openId.current);
    const ctx = legContextOf(useStore.getState());
    if (!o || !ctx || (!ctx.cold && !(await requestAuth()))) {
      return;
    }
    if (!ctx.cold) {
      await openSwapUnlock(o.id, o.expiresAt, ctx.legsPerUnlock);
    }
    runSwapLegs(o, ctx);
  };

  const reset = () => {
    forget();
    setStep('input');
    setFirm(undefined);
    setSwapT(undefined);
    setStatus(undefined);
    setDepositTxid(undefined);
    setError(undefined);
    setAmount(undefined);
  };

  // what this form would fill for someone else: never this wallet's own refund
  // address, and a route only when the user pinned one
  const sharedRoute = pinned ?? (key ? chosen[key] : undefined);
  const shareLink =
    token &&
    toUri({
      kind: 'swap',
      swap: {
        direction,
        token: token.symbol.toLowerCase(),
        chain: token.chain,
        amount: amountIn || undefined,
        address: isFromZec ? otherAddress || undefined : undefined,
        route: sharedRoute,
      },
    });

  const header = (meta?: ReactNode) => <ScreenHeader title='swap' onBack={goBack} meta={meta} />;

  if (resuming || (step === 'input' && !decided)) {
    return <div className='flex h-full flex-col bg-canvas'>{header()}</div>;
  }

  if (step === 'input') {
    const updatedAt = shown?.dataUpdatedAt ?? 0;
    const next = view && updatedAt + (refreshIn(view, updatedAt, updatedAt) || 0);
    const note = deal && NOTE[deal.route][direction];
    const helper =
      error ??
      pinnedRefusal ??
      (overMax ? `${fromUnits(maxZat, 8)} zec can be sent` : undefined) ??
      (quote ? undefined : below?.message);
    return (
      <div
        className='flex h-full flex-col bg-canvas'
        // enter goes to review once a price is here
        onKeyDown={e => {
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement && reviewable) {
            e.preventDefault();
            openReview();
          }
        }}
      >
        {PasswordModal}
        {header(
          pinned ? (
            `via ${ROUTES[pinned].label}`
          ) : expiredLive ? (
            <span className='text-hanko-light'>this price has ended · please ask again</span>
          ) : (
            <>
              {asking}
              {!!next && !fetching && !reviewOpen && <Drain at={next} />}
            </>
          ),
        )}
        <Main className='gap-[18px] pt-5'>
          <div className='flex flex-col gap-2'>
            <AmountField
              label='you pay'
              value={amountIn}
              onChange={v => {
                setAmount(v);
                setError(undefined);
              }}
              unit={isFromZec ? 'zec' : tokenQuery.isFetching ? 'reading' : unit}
              onUnit={isFromZec ? undefined : () => setPickerOpen(true)}
              available={isFromZec ? balanceZec : undefined}
              helper={helper}
              warn={!!helper}
            />
            {quick.length > 0 && (
              <div className='-mt-1 flex justify-end gap-1.5'>
                {quick.map(c => (
                  <button
                    key={c.label}
                    type='button'
                    onClick={() => setAmount(c.amount)}
                    aria-pressed={c.amount === amountIn}
                    className={cn(
                      'h-7 border px-2.5 text-[11px] transition-colors',
                      c.amount === amountIn
                        ? 'border-zigner-gold text-fg-high'
                        : 'border-border-soft text-fg-muted hover:border-border-hard hover:text-fg-high',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant='secondary'
            size='sm'
            onClick={flip}
            aria-label={isFromZec ? 'swap into zec instead' : 'swap out of zec instead'}
            className='-my-3 size-11 self-center p-0'
          >
            <span className='i-lucide-arrow-up-down size-4' aria-hidden='true' />
          </Button>
          <div className='flex flex-col gap-1.5'>
            <span className='text-xs text-fg-muted'>
              you get{token && isFromZec ? ` · on ${chainName(token.chain)}` : ''}
            </span>
            {/* out of zec it picks the token; into zec it only shows the figure (the flip button reverses) */}
            {isFromZec ? (
              <button
                type='button'
                onClick={() => setPickerOpen(true)}
                aria-label={`choose what you get · now ${unit}`}
                className='flex h-14 items-center justify-between border border-border-soft bg-elev-1 px-3 text-left'
              >
                <YouGet view={view} stale={stale} struck={expiredLive} />
                <span className='flex items-center gap-1 text-[13px] text-fg-muted lowercase'>
                  {tokenQuery.isFetching ? 'reading' : unit}
                  <span className='i-lucide-chevron-down size-3' />
                </span>
              </button>
            ) : (
              <output
                aria-label='what you get, in zec'
                className='flex h-14 items-center justify-between border border-border-soft bg-elev-1 px-3'
              >
                <YouGet view={view} stale={stale} struck={expiredLive} />
                <span className='text-[13px] text-fg-muted lowercase'>zec</span>
              </output>
            )}
          </div>
          {token && (
            <div className='flex flex-col gap-1.5'>
              <div className='relative'>
                <button
                  type='button'
                  onClick={() => setRoutesOpen(true)}
                  disabled={!quotes.length}
                  className='flex h-24 w-full flex-col justify-center gap-1 overflow-hidden border border-border-soft bg-elev-1 py-2.5 pl-4 pr-10 text-left disabled:cursor-default'
                >
                  {view ? (
                    <>
                      <span className='flex items-center justify-between text-sm text-fg-high'>
                        {routeLabel(view.route, view.route === best?.route)}
                        <span className='i-lucide-chevron-right size-3.5 text-fg-muted' />
                      </span>
                      <span
                        className={cn(
                          'flex flex-wrap gap-x-3 text-[11px] text-fg-muted transition-opacity duration-300',
                          stale && 'opacity-50',
                        )}
                      >
                        <RouteMeta quote={view} unit={outUnit} decimals={outDecimals} />
                      </span>
                    </>
                  ) : (
                    <span className='text-[11px] text-fg-muted'>
                      {allFailed
                        ? 'no route can take this right now · nothing was sent'
                        : fetching
                          ? 'asking for prices'
                          : 'route'}
                    </span>
                  )}
                </button>
                {view && (
                  <button
                    type='button'
                    onClick={() => setCustodyOpen(true)}
                    aria-label='who holds the funds on this route'
                    className='absolute bottom-1.5 right-1.5 grid size-8 place-items-center text-fg-muted hover:text-fg-high'
                  >
                    <span className='i-ph-question size-3.5' aria-hidden='true' />
                  </button>
                )}
              </div>
              <div ref={routeList} className='flex flex-col'>
                {lines.map(({ deepen, ...l }) => (
                  <div key={l.route} data-key={l.route} className='flex min-w-0 items-center gap-3'>
                    <RouteLine {...l} />
                    {deepen && <DeepenLink />}
                  </div>
                ))}
              </div>
            </div>
          )}
          {payerRefunds ? (
            <p className='flex items-center gap-2 text-[11px] text-fg-muted'>
              <span className='i-ph-arrow-u-up-left size-3.5 shrink-0' aria-hidden='true' />
              {PAYER_REFUNDS}
            </p>
          ) : (
            <ToField
              id='swap-other'
              label={
                isFromZec
                  ? `${token ? chainName(token.chain) : 'destination'} recipient`
                  : `your ${token ? chainName(token.chain) : 'source'} address · for refunds`
              }
              value={typedAddress ?? otherAddress}
              onChange={v => {
                if (looksLikeLink(v)) {
                  navigate(PopupPath.LINK, { state: { uri: v, via: 'pasted' } });
                  return;
                }
                setAddress(v);
              }}
              placeholder={isFromZec ? 'recipient address' : 'your address'}
              onContacts={fieldChain ? () => setContactsOpen(true) : undefined}
            >
              {!isFromZec && fieldChain && (
                <label
                  className={cn(
                    'flex items-center gap-2 text-[11px] text-fg-muted',
                    otherValid && !known ? 'cursor-pointer' : 'opacity-60',
                  )}
                >
                  <input
                    type='checkbox'
                    checked={known || rememberIt}
                    disabled={known || !otherValid}
                    onChange={e => setRememberIt(e.target.checked)}
                    className='size-3.5 shrink-0 accent-[var(--zigner-gold)]'
                  />
                  {known
                    ? `one of your ${chainLabel(fieldChain)} addresses`
                    : `remember as my ${chainLabel(fieldChain)} address`}
                </label>
              )}
            </ToField>
          )}
          {cashOut && <PeerCashOutNote />}
          {shareLink && (
            <CopyButton text={shareLink} label='copy swap link' className='self-start px-0' />
          )}
        </Main>
        <Footer>
          <Button className='w-full' onClick={openReview} disabled={!reviewable}>
            review swap
          </Button>
        </Footer>
        <TokenSheet
          title={isFromZec ? 'you get' : 'you pay'}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          tokens={tokens}
          loading={tokenQuery.isFetching}
          onPick={t => choosePair(direction, t)}
          lead={isFromZec ? <CashOutRow onPress={pickCashOut} /> : <BuyCashRow />}
        />
        {fieldChain && (
          <AddressSheet
            chain={fieldChain}
            open={contactsOpen}
            onOpenChange={setContactsOpen}
            onPick={row => setAddress(row.address)}
            onPaste={() => document.getElementById('swap-other')?.focus()}
          />
        )}
        {view && (
          <Sheet
            open={custodyOpen}
            onOpenChange={setCustodyOpen}
            title={`${ROUTES[view.route].label} · who holds it`}
          >
            <p className='text-xs text-fg'>{ROUTES[view.route].custody}</p>
            <p className='text-xs text-fg-muted'>{NOTE[view.route][direction]}</p>
          </Sheet>
        )}
        <Sheet open={routesOpen} onOpenChange={setRoutesOpen} title='route'>
          {quotes.map(q => (
            <RouteChoice
              key={q.route}
              quote={q}
              unit={outUnit}
              on={q.route === quote?.route}
              best={q.route === best?.route}
              more={q.route === best?.route ? more : undefined}
              decimals={outDecimals}
              onPick={() => pickRoute(q.route)}
            />
          ))}
          {quiet.map(r => (
            <RouteLine key={r.route} route={r.route} line={r.line} />
          ))}
        </Sheet>
        {deal && firm && (
          <Sheet
            open={reviewOpen}
            onOpenChange={o => !o && closeReview()}
            title='review swap'
            footer={
              <div className='flex gap-2 pt-3'>
                <Button variant='secondary' className='flex-1' onClick={closeReview}>
                  back
                </Button>
                {expired ? (
                  // the price moved on: closing review asks again, nothing was sent
                  <Button className='flex-1' onClick={closeReview}>
                    get a new quote
                  </Button>
                ) : (
                  <Button
                    className='flex-1'
                    onClick={() => void recheck()}
                    disabled={thorOut && !reviewedPlan}
                    loading={checking}
                  >
                    {askCustody && 'understood · '}
                    {isFromZec
                      ? kind === 'zigner'
                        ? 'sign with zigner'
                        : 'swap'
                      : 'show deposit address'}
                  </Button>
                )}
              </div>
            }
          >
            <div className='flex flex-col gap-1.5 text-xs'>
              {/* only the amounts hide; the addresses and memo are what gets reviewed */}
              {(
                [
                  ['you send', `${deal.amountInText || firm.req.amountIn} ${inUnit}`, true],
                  ['you receive', `${deal.amountOutText} ${outUnit}`, true],
                  ...(deal.atLeastText
                    ? [['at least', `${deal.atLeastText} ${outUnit}`, true]]
                    : []),
                  ['route', ROUTES[deal.route].label],
                  ['recipient', deal.recipient],
                  [isFromZec ? 'deposit address' : 'pay to', deal.depositAddress || 'on confirm'],
                  ...(deal.memo ? [['memo', deal.memo]] : []),
                ] as [string, string, boolean?][]
              ).map(([k, v, amount]) => (
                <div key={k} className='flex justify-between gap-3'>
                  <span className='shrink-0 text-fg-muted'>{k}</span>
                  <span className='break-all text-right font-mono'>
                    {/* a firm price that moved from the live one shows the old one struck */}
                    {k === 'you receive' && firm.was && firm.was.amountOut !== deal.amountOut && (
                      <Sensitive className='mr-2 text-fg-muted line-through'>
                        {firm.was.amountOutText}
                      </Sensitive>
                    )}
                    {amount ? <Sensitive>{v}</Sensitive> : v}
                  </span>
                </div>
              ))}
              {deal.cost && <CostList cost={deal.cost} unit={outUnit} decimals={outDecimals} />}
            </div>
            {thorOut && (
              <p className='text-xs text-fg'>
                {reviewedPlan ? (
                  <>
                    {moving && (
                      <>
                        moves <Sensitive>{`${zecOf(reviewedPlan.short)} zec`}</Sensitive> to this
                        swap's own address{' '}
                        <span className='font-mono'>{tLook && <Addr>{tLook.address}</Addr>}</span>,
                        then{' '}
                      </>
                    )}
                    sends <Sensitive>{`${firm.req.amountIn} zec`}</Sensitive> to the{' '}
                    {ROUTES[deal.route].label} vault · fees{' '}
                    <Sensitive>{`${moving ? `${zecOf(moveFee)} + ` : ''}${zecOf(reviewedPlan.fee)} zec`}</Sensitive>
                  </>
                ) : planAsk.error ? (
                  <span className='text-warn'>{plain(deal.route, planAsk.error)}</span>
                ) : (
                  <span className='text-fg-muted'>reading the swap's address</span>
                )}
              </p>
            )}
            {deal.route === best?.route && more && (
              <p className='text-xs text-fg-muted'>
                you get <Sensitive className='text-success'>{`${more} ${outUnit}`}</Sensitive> more
                than the next route
              </p>
            )}
            {note && (
              <p className={cn('text-xs', askCustody ? 'text-warn' : 'text-fg-muted')}>{note}</p>
            )}
            {deal.streamLine && <p className='text-xs text-fg-muted'>{deal.streamLine}</p>}
            {deal.refundLine && <p className='text-xs text-fg-muted'>{deal.refundLine}</p>}
            <p className='text-xs text-fg-muted'>
              {ROUTES[deal.route].label} · {ROUTES[deal.route].custody}
              {deal.expiresAt && !expired && ` · good for ${untilLabel(left)}`}
              {deal.route === 'near' && (
                <>
                  {' · '}
                  <a
                    href='https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-terms-of-service'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='underline underline-offset-2 hover:text-fg-high'
                  >
                    terms
                  </a>
                </>
              )}
            </p>
            {link?.via && <p className='text-[11px] text-fg-muted'>{viaLine(link.via)}</p>}
          </Sheet>
        )}
      </div>
    );
  }

  if (step === 'thor-out' && deal && firm && swapT && openId.current) {
    return (
      <>
        {PasswordModal}
        <ThorOutTracker
          id={openId.current}
          storeId={storeId ?? selectedKeyInfo?.id ?? ''}
          amountZat={toUnits(firm.req.amountIn, 8)}
          tAddress={swapT.address}
          vault={ROUTES[deal.route].label}
          onSent={txid => {
            setDepositTxid(txid);
            setStep('polling');
          }}
          onLeave={() => navigate(PopupPath.INDEX)}
          onResume={() => void resumeHeld()}
          // a fresh price for the same swap: its address (and any zec moved there) is kept
          onAgain={() => {
            forget();
            setStep('input');
          }}
          onDrop={() => {
            forget();
            navigate(PopupPath.INDEX);
          }}
        />
      </>
    );
  }

  return (
    <div className='flex h-full flex-col bg-canvas'>
      {PasswordModal}
      {header()}
      <Main className='gap-3 pt-4'>
        {step === 'sign' && signRequestQr && (
          <div className='flex flex-col items-center gap-4 py-4'>
            <QrDisplay
              data={signRequestQr}
              size={220}
              title='scan with zigner'
              description='scan this QR with your signer'
            />
            <p className='text-center text-sm text-fg-muted'>
              open zigner, scan this code, then review and approve
            </p>
            {error && <p className='text-center text-xs text-warn'>{error}</p>}
          </div>
        )}

        {step === 'scan' && (
          <QrScanner
            onScan={data => void signatureScanned(data)}
            // a camera that won't start goes back to the qr, saying so there
            onError={err => {
              setError(typeof err === 'string' ? err : "that code didn't scan · please try again");
              setStep('sign');
            }}
            onClose={() => setStep('sign')}
            title='scan signature'
            description='point camera at signer QR code'
          />
        )}

        {step === 'sending' && (
          <div className='flex flex-col items-center gap-4 py-6'>
            <h2 className='text-lg'>building transaction</h2>
            <LiveTimer startMs={buildStartRef.current} />
            <StepList steps={sendSteps} className='w-full max-w-sm' />
          </div>
        )}

        {(step === 'deposit' || step === 'polling') && deal && (
          <>
            {step === 'deposit' && !isFromZec && (
              <DepositCard
                deal={deal}
                unit={inUnit}
                chain={token && chainName(token.chain)}
                memoHow={carrier ? MEMO_HOW[carrier] : undefined}
                refunds={pair && refundsToPayer(deal.route, pair) ? PAYER_REFUNDS : undefined}
              />
            )}
            {watchable ? (
              <StatusSlot tone='info' icon='i-ph-arrows-clockwise'>
                {status?.line ?? 'waiting for the deposit'}
              </StatusSlot>
            ) : (
              <StatusSlot tone='info' icon='i-lucide-eye'>
                the zec lands at your transparent address · you can shield it from home
              </StatusSlot>
            )}
          </>
        )}

        {step === 'done' && (
          <StatusSlot tone='gold' icon='i-ph-check'>
            swap complete ·{' '}
            <Sensitive>{`${deal?.amountInText ?? ''} ${inUnit} - ${deal?.amountOutText ?? ''} ${outUnit}`}</Sensitive>
          </StatusSlot>
        )}
        {step === 'done' && deal?.cost && (
          <div className='flex flex-col gap-1.5 text-xs'>
            <CostList cost={deal.cost} unit={outUnit} decimals={outDecimals} />
          </div>
        )}

        {cashOut && (step === 'deposit' || step === 'polling' || step === 'done') && (
          <PeerCashOutNote />
        )}
        {step === 'refunded' && <RefundedSlot line={status?.line} />}
        {step === 'error' &&
          (isEgressBlocked(errorCause) ? (
            <EgressBlockedStatus error={errorCause} onAllowed={() => setStep('input')} />
          ) : (
            <StatusSlot tone='danger'>{error}</StatusSlot>
          ))}
      </Main>
      <Footer>
        {step === 'sign' && (
          <Button
            className='w-full'
            onClick={() => {
              setError(undefined);
              setStep('scan');
            }}
          >
            scan signature
          </Button>
        )}
        {/* the swap stays on home until it ends; only "stop watching" lets it go */}
        {(step === 'deposit' || step === 'polling') && watchable && (
          <Button variant='secondary' className='grow' onClick={reset}>
            stop watching
          </Button>
        )}
        {(step === 'deposit' || step === 'polling') && (
          <Button className='grow' onClick={() => navigate(PopupPath.INDEX)}>
            done
          </Button>
        )}
        {step === 'refunded' && (
          <Button
            className='w-full'
            onClick={() => {
              forget();
              navigate(PopupPath.INDEX);
            }}
          >
            done
          </Button>
        )}
        {(step === 'done' || step === 'error') && (
          <Button className='w-full' onClick={reset}>
            {step === 'done' ? 'swap again' : 'try again'}
          </Button>
        )}
      </Footer>
    </div>
  );
};
