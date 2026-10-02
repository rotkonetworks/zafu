/**
 * Swap zec with another chain over whichever route carries it (board Swap,
 * StSwapExpired). Nothing is asked of any route until "get quote": then every
 * route that can carry the pair is quoted side by side (or only the one a link
 * pinned with `xc=`), the most out after fees is preselected, and the user
 * reviews before anything is signed or shown to pay.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { StepList } from '@repo/ui/components/ui/step-list';
import { QrCode } from '../../../components/qr-code';
import { Sensitive } from '../../../components/sensitive';
import { ScreenHeader } from '../../../components/screen-header';
import { useStore } from '../../../state';
import { selectEffectiveKeyInfo, selectGetVaultUnlock } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { activeAccountIndex, activeZcashStoreId } from '../../../state/pockets';
import { CAPS, walletKind } from '../../../signing/wallet-kind';
import { isEgressBlocked } from '../../../net/egress';
import { EgressBlockedStatus } from '../../../shared/components/egress-blocked-status';
import { useActiveAddress } from '../../../hooks/use-address';
import { useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { useDeadlineCountdown } from '../../../hooks/use-deadline-countdown';
import { useSwapRoutes } from '../../../hooks/swap-routes';
import { usePasswordGate } from '../../../hooks/password-gate';
import {
  getBalanceInWorker,
  buildSendTxInWorker,
  completeSendTxInWorker,
} from '../../../state/keyring/network-worker';
import { blockchainToContactNetwork, toBaseUnits } from '../../../state/near-swap';
import { PROVIDERS, quoteRoutes, routeTokens, type RouteResult } from '../../../state/swap';
import {
  fromUnits,
  lead,
  toUnits,
  type SwapStatusView,
  type SwapToken,
} from '../../../state/swap/provider';
import { BelowMinimum } from '../../../state/swap/thornode';
import {
  candidates,
  pairKey,
  ROUTES,
  ROUTE_IDS,
  routeLabel,
  poolAsset,
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
import type { ContactNetwork } from '../../../state/contacts';
import { useBackNav, usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { looksLikeLink, toUri } from '../../../links/router';
import { viaLine, type SwapLinkState } from '../../../links/land';
import { Footer, Main } from '../send/send-ui';
import { ThorDeposit } from './thor-deposit';
import { AmountField, ContactsSheet, ToField } from '../send/send-fields';
import { chainName } from '../../../state/swap/tokens';
import { TokenSheet } from './token-sheet';
import { CostList, CostMeta } from './cost-lines';
import { ThorNameResolver } from '../../../components/thorname-resolver';

type Step =
  | 'input'
  | 'quoting'
  | 'routes'
  | 'thor-out'
  | 'sign'
  | 'scan'
  | 'sending'
  | 'deposit'
  | 'polling'
  | 'done'
  | 'error';

/** routes with an implementation: the picker and best-route draw from these */
const QUOTABLE = ROUTE_IDS.filter(id => PROVIDERS[id]);

/** the one note under the routes, per route and direction */
const NOTE: Record<RouteId, Record<SwapPair['direction'], string>> = {
  near: {
    into_zec: 'a third-party solver holds your funds during the swap. it can delay or freeze them.',
    from_zec: 'a third-party solver holds your zec during the swap. it can delay or freeze it.',
  },
  thor: {
    into_zec:
      'thorchain pays transparent addresses only. the zec lands at your t-address, ready to shield.',
    from_zec: 'leaves the shielded pool through your transparent address. that step is public.',
  },
  penumbra: { into_zec: '', from_zec: '' },
};

const MEMO_HOW: Record<MemoCarrier, string> = {
  op_return: 'add it to the payment as an op_return output, exactly as shown',
  memo: "put it in the payment's memo field, exactly as shown",
};

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const errorLine = (e: unknown) =>
  e instanceof Error && e.message ? e.message : 'the route did not answer · please try again';

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

/** one route in the board's route choice: a square mark, name, amount, one meta line */
const RouteChoice = ({
  result,
  unit,
  on,
  best,
  more,
  decimals,
  onPick,
}: {
  result: RouteResult;
  unit: string;
  decimals: number;
  on: boolean;
  best: boolean;
  /** how much more than the next route, on the best one */
  more?: string;
  onPick: () => void;
}) => {
  const quote = 'quote' in result ? result.quote : undefined;
  const live = !!quote && !quote.notYet;
  return (
    <button
      type='button'
      onClick={onPick}
      disabled={!live}
      aria-pressed={on}
      className={cn(
        'flex w-full flex-col gap-2 border px-4 py-3.5 text-left transition-colors',
        on ? 'border-zigner-gold bg-zigner-gold/10' : 'border-border-soft bg-elev-1',
        live ? 'hover:border-border-hard' : 'cursor-default opacity-70',
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
        <span className='grow text-sm text-fg-high'>{routeLabel(result.route, best)}</span>
        {quote && (
          <span className='text-sm text-fg-high'>
            <Sensitive>{`${quote.amountOutText} ${unit}`}</Sensitive>
          </span>
        )}
      </span>
      <span className='flex flex-wrap gap-x-3 pl-7 text-[11px] text-fg-muted'>
        {quote ? (
          <>
            {quote.timeText && <span>{quote.timeText}</span>}
            {more && (
              <span>
                <Sensitive className='text-success'>{`${more} ${unit}`}</Sensitive> more
              </span>
            )}
            {quote.cost && <CostMeta cost={quote.cost} unit={unit} decimals={decimals} />}
            <span
              className={
                quote.notYet
                  ? 'text-fg-muted'
                  : result.route === 'near'
                    ? 'text-warn'
                    : 'text-success'
              }
            >
              {quote.notYet ?? ROUTES[result.route].custody}
            </span>
          </>
        ) : (
          <span className='lowercase'>
            {errorLine('error' in result ? result.error : undefined)}
          </span>
        )}
      </span>
    </button>
  );
};

export const CrosschainSwap = ({ link }: { link?: SwapLinkState }) => {
  const goBack = useBackNav(PopupPath.INDEX);
  const navigate = usePopupNav();
  const { address: zcashAddress } = useActiveAddress();
  const { tAddresses } = useTransparentAddresses(true);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const storeId = useStore(activeZcashStoreId);
  const pocket = useStore(activeAccountIndex);
  const kind = selectedKeyInfo && walletKind(selectedKeyInfo, activeZcashWallet);
  const ufvk =
    activeZcashWallet?.ufvk ??
    (activeZcashWallet?.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);
  const { requestAuth, PasswordModal } = usePasswordGate();
  const { chosen, choose } = useSwapRoutes();

  const pinned = link?.link.route;
  const [step, setStep] = useState<Step>('input');
  const [direction, setDirection] = useState(link?.link.direction ?? 'into_zec');
  const [amountIn, setAmountIn] = useState(link?.link.amount ?? '');
  const [token, setToken] = useState<SwapToken>();
  // a link names its token by symbol: the picker opens (its list is the
  // fetch the egress sheet asks about) and picks it once the list is here
  const [linkToken, setLinkToken] = useState(link?.link);
  const [pickerOpen, setPickerOpen] = useState(!!link);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [otherAddress, setOtherAddress] = useState(link?.link.address ?? '');
  // the THORName the address was resolved from; it counts only while that address is still in the field
  const [resolvedName, setResolvedName] = useState<{ name: string; address: string }>();
  const otherName = resolvedName?.address === otherAddress ? resolvedName.name : undefined;
  const [results, setResults] = useState<RouteResult[]>([]);
  const [picked, setPicked] = useState<RouteId>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [status, setStatus] = useState<SwapStatusView>();
  const [depositTxid, setDepositTxid] = useState<string>();
  const [error, setError] = useState<string>();
  // a route's minimum, kept when it was the only thing in the way
  const [minimum, setMinimum] = useState<{ key: string; min: bigint; line: string }>();
  // kept alongside the message so a blocked destination can offer an inline allow
  const [errorCause, setErrorCause] = useState<unknown>();
  const [balanceZec, setBalanceZec] = useState<string>();
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const unsignedTxRef = useRef<any | null>(null);
  const [sendSteps, setSendSteps] = useState<
    { step: string; detail?: string; elapsedMs: number }[]
  >([]);
  const buildStartRef = useRef(0);

  const isFromZec = direction === 'from_zec';
  const pair: SwapPair | undefined = token && {
    direction,
    symbol: token.symbol.toLowerCase(),
    chain: token.chain,
  };
  const key = pair && pairKey(pair);
  const pinnedRefusal = pinned && pair ? ROUTES[pinned].refuses(pair) : undefined;
  const unit = token?.symbol.toLowerCase() ?? 'select';
  const outUnit = isFromZec ? unit : 'zec';
  const inUnit = isFromZec ? 'zec' : unit;

  const quotes = results.flatMap(r => ('quote' in r ? [r.quote] : []));
  const best = quotes.find(q => !q.notYet);
  const live = (id?: RouteId) => quotes.find(q => q.route === id && !q.notYet);
  const quote = live(picked) ?? live(key ? chosen[key] : undefined) ?? best;
  const outDecimals = isFromZec ? (token?.decimals ?? 8) : 8;
  const ahead = lead(quotes);
  const more = ahead ? fromUnits(ahead, outDecimals) : undefined;
  const belowMin = !!minimum && minimum.key === key && toUnits(amountIn, 8) < minimum.min;
  // only routes zafu can't send yet: shown for comparison, nothing to review
  const view = quote ?? quotes[0];
  const carrier = pair && quote && poolAsset(quote.route, pair)?.carrier;
  // thornames resolve to thorchain's own chain naming
  const aliasChain = pair && poolAsset('thor', pair)?.asset.split('.')[0];
  const left = useDeadlineCountdown(step === 'routes' ? (view?.expiresAt ?? null) : null);
  const expired = step === 'routes' && !!view?.expiresAt && view.expiresAt <= Date.now();
  const provider = quote && PROVIDERS[quote.route];
  const watchable =
    !!provider?.status &&
    (quote?.watch === 'deposit' || (quote?.watch === 'txid' && !!depositTxid));

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

  const walletId = selectedKeyInfo?.id;
  useEffect(() => {
    if (!walletId) {
      return;
    }
    getBalanceInWorker('zcash', walletId)
      .then(b => setBalanceZec((Number(b) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')))
      .catch(() => {});
  }, [walletId]);

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

  const contactNetwork = token
    ? (blockchainToContactNetwork(token.chain) as ContactNetwork | undefined)
    : undefined;

  const flip = () => {
    setDirection(d => (d === 'from_zec' ? 'into_zec' : 'from_zec'));
    setAmountIn('');
    setOtherAddress('');
  };

  const requestQuotes = async () => {
    if (!token || !pair || !zcashAddress) {
      return;
    }
    setStep('quoting');
    setError(undefined);
    setPicked(undefined);
    try {
      const got = await quoteRoutes(candidates(pair, pinned), {
        direction,
        token,
        amountIn,
        zcashAddress,
        zcashTransparent: tAddresses[0],
        otherAddress,
        otherName,
        signsOpReturn: !!kind && !!CAPS[kind].opReturn,
      });
      const failed = got.find(r => 'error' in r);
      if (!got.some(r => 'quote' in r)) {
        const below = got.flatMap(r =>
          'error' in r && r.error instanceof BelowMinimum ? [r.error] : [],
        )[0];
        if (below && key) {
          setMinimum({ key, min: below.min, line: below.message });
          setStep('input');
          return;
        }
        const cause = failed && 'error' in failed ? failed.error : undefined;
        setErrorCause(cause);
        setError(
          got.length ? errorLine(cause) : 'no route was allowed · nothing was asked of anyone',
        );
        setStep('error');
        return;
      }
      setResults(got);
      setRiskAcknowledged(false);
      setStep('routes');
    } catch (err) {
      setErrorCause(err);
      setError(errorLine(err));
      setStep('error');
    }
  };

  const pickRoute = (route: RouteId) => {
    setPicked(route);
    // remember only a change from the best route, and never over a link's pin
    if (key && !pinned) {
      void choose(key, route === best?.route ? undefined : route);
    }
  };

  const confirm = async () => {
    if (!quote || !selectedKeyInfo) {
      return;
    }
    setReviewOpen(false);
    setError(undefined);

    // into zcash: the user pays from their other wallet; zafu shows where and watches
    if (!isFromZec) {
      setStep('deposit');
      return;
    }
    if (quote.notYet) {
      return;
    }
    // a memo deposit is never a shielded send: a t->t with an OP_RETURN, its own steps
    if (quote.memo) {
      setStep('thor-out');
      return;
    }

    try {
      const walletId = selectedKeyInfo.id;
      const amountZat = toBaseUnits(amountIn, 8);
      if (selectedKeyInfo.type === 'mnemonic') {
        if (!(await requestAuth())) {
          setStep('routes');
          return;
        }
        setSendSteps([]);
        buildStartRef.current = Date.now();
        setStep('sending');
        const vault = await getVaultUnlock(walletId);
        const result = await buildSendTxInWorker(
          'zcash',
          storeId ?? walletId,
          zidecarUrl,
          quote.depositAddress,
          amountZat,
          '',
          pocket,
          true,
          vault,
        );
        if (!('txid' in result)) {
          throw new Error('failed to broadcast deposit transaction');
        }
        setStep('polling');
        return;
      }

      // zigner flow
      if (!ufvk) {
        throw new Error('UFVK required for zigner wallet send');
      }
      setSendSteps([]);
      buildStartRef.current = Date.now();
      setStep('sending');
      const result = await buildSendTxInWorker(
        'zcash',
        walletId,
        zidecarUrl,
        quote.depositAddress,
        amountZat,
        '',
        0,
        true,
        undefined,
        ufvk,
      );
      if (!('sighash' in result)) {
        throw new Error('unexpected unsigned tx result');
      }
      unsignedTxRef.current = result;
      setSignRequestQr(
        encodeZcashSignRequest({
          accountIndex: 0,
          sighash: hexToBytes(result.sighash),
          orchardAlphas: result.alphas.map(a => hexToBytes(a)),
          summary: `swap ${amountIn} ZEC`,
          mainnet: true,
        }),
      );
      setStep('sign');
    } catch (err) {
      console.error('[swap] send failed', err);
      setErrorCause(err);
      setError(err instanceof Error ? err.message : 'failed to send deposit');
      setStep('error');
    }
  };

  const signatureScanned = async (data: string) => {
    try {
      if (!isZcashSignatureQR(data)) {
        setError('invalid signature qr code');
        setStep('error');
        return;
      }
      const sigResponse = parseZcashSignatureResponse(data);
      if (!unsignedTxRef.current || !selectedKeyInfo) {
        throw new Error('missing unsigned tx');
      }
      setStep('sending');
      const result = await completeSendTxInWorker(
        'zcash',
        selectedKeyInfo.id,
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
        throw new Error('failed to broadcast');
      }
      setStep('polling');
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'failed to complete zigner tx');
      setStep('error');
    }
  };

  // watch the swap while the deposit is out, on routes that can be watched
  useEffect(() => {
    if ((step !== 'deposit' && step !== 'polling') || !quote || !watchable) {
      return;
    }
    const watch = provider.status!;
    const interval = setInterval(async () => {
      try {
        const next = await watch(quote, depositTxid);
        setStatus(next);
        if (next.phase === 'done') {
          setStep('done');
        } else if (next.phase === 'failed') {
          setError(next.line);
          setStep('error');
        } else if (next.phase === 'processing') {
          setStep('polling');
        }
      } catch (err) {
        console.error('[swap-status] poll failed', err);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [step, quote, provider, watchable, depositTxid]);

  const reset = () => {
    setStep('input');
    setResults([]);
    setStatus(undefined);
    setDepositTxid(undefined);
    setError(undefined);
    setAmountIn('');
  };

  const canQuote =
    !!token &&
    parseFloat(amountIn) > 0 &&
    !!zcashAddress &&
    !!otherAddress &&
    !pinnedRefusal &&
    !belowMin;
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

  const header = (meta?: ReactNode) => (
    <ScreenHeader
      title='swap'
      onBack={step === 'routes' ? () => setStep('input') : goBack}
      meta={meta}
    />
  );

  if (step === 'input' || step === 'quoting') {
    return (
      <div className='flex h-full flex-col bg-canvas'>
        {PasswordModal}
        {header(pinned ? `via ${ROUTES[pinned].label}` : undefined)}
        <Main className='gap-[18px] pt-5'>
          <AmountField
            label='you pay'
            value={amountIn}
            onChange={setAmountIn}
            unit={isFromZec ? 'zec' : tokenQuery.isFetching ? 'reading' : unit}
            onUnit={isFromZec ? undefined : () => setPickerOpen(true)}
            available={isFromZec ? balanceZec : undefined}
            onMax={
              isFromZec && balanceZec
                ? () => {
                    const max = Math.max(0, parseFloat(balanceZec) - 0.0001);
                    setAmountIn(max.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
                  }
                : undefined
            }
            helper={error ?? pinnedRefusal ?? (belowMin ? minimum.line : undefined)}
            warn={!!(error ?? pinnedRefusal) || belowMin}
          />
          <Button
            variant='secondary'
            size='sm'
            onClick={flip}
            aria-label={isFromZec ? 'swap into zec instead' : 'swap out of zec instead'}
            className='-my-3 size-11 self-center p-0'
          >
            <span className='i-lucide-arrow-up-down size-4' aria-hidden='true' />
          </Button>
          <RowGroup>
            <Row
              type='value'
              label='you get'
              description={token && isFromZec ? `on ${chainName(token.chain)}` : undefined}
              value={isFromZec ? (tokenQuery.isFetching ? 'reading' : unit) : 'zec'}
              onPress={isFromZec ? () => setPickerOpen(true) : flip}
            />
          </RowGroup>
          <ToField
            id='swap-other'
            label={
              isFromZec
                ? `${token ? chainName(token.chain) : 'destination'} recipient`
                : `your ${token ? chainName(token.chain) : 'source'} address · for refunds`
            }
            value={otherAddress}
            onChange={v => {
              if (looksLikeLink(v)) {
                navigate(PopupPath.LINK, { state: { uri: v, via: 'pasted' } });
                return;
              }
              setOtherAddress(v);
            }}
            placeholder={isFromZec ? 'recipient address' : 'your address'}
            onContacts={contactNetwork ? () => setContactsOpen(true) : undefined}
          >
            <ThorNameResolver
              input={otherAddress}
              chain={aliasChain}
              onResolve={(address, name) => {
                setResolvedName({ name, address });
                setOtherAddress(address);
              }}
            />
          </ToField>
          {shareLink && (
            <CopyButton text={shareLink} label='copy swap link' className='self-start px-0' />
          )}
        </Main>
        <Footer>
          <Button
            className='w-full'
            onClick={() => void requestQuotes()}
            disabled={!canQuote}
            loading={step === 'quoting'}
          >
            get quote
          </Button>
        </Footer>
        <TokenSheet
          title={isFromZec ? 'you get' : 'you pay'}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          tokens={tokens}
          loading={tokenQuery.isFetching}
          onPick={t => {
            setToken(t);
            setOtherAddress('');
          }}
        />
        {contactNetwork && (
          <ContactsSheet
            network={contactNetwork}
            open={contactsOpen}
            onOpenChange={setContactsOpen}
            onPick={row => setOtherAddress(row.address)}
          />
        )}
      </div>
    );
  }

  if (step === 'thor-out' && quote) {
    return (
      <ThorDeposit
        quote={quote}
        amountZat={toUnits(amountIn, 8)}
        onSent={txid => {
          setDepositTxid(txid);
          setStep('polling');
        }}
        onBack={() => setStep('routes')}
        onExpired={() => void requestQuotes()}
      />
    );
  }

  if (step === 'routes' && view) {
    const note = quote && NOTE[quote.route][direction];
    return (
      <div className='flex h-full flex-col bg-canvas'>
        {PasswordModal}
        {header(
          expired ? (
            <span className='text-hanko-light'>quote expired</span>
          ) : (
            `good for ${mmss(left)}`
          ),
        )}
        <Main className='gap-3 pt-4'>
          <div className='flex flex-col border border-border-soft bg-elev-1'>
            {[
              ['you pay', amountIn, inUnit],
              ['you get', view.amountOutText, outUnit],
            ].map(([label, figure, u], i) => (
              <div
                key={label}
                className={cn(
                  'flex items-center justify-between px-4 py-2.5',
                  i && 'border-t border-border-soft',
                )}
              >
                <span className='flex flex-col gap-1.5'>
                  <span className='text-[11px] text-fg-muted'>{label}</span>
                  <span className='font-display text-[22px] leading-none text-fg-high'>
                    <Sensitive className={cn(expired && i && 'line-through')}>{figure}</Sensitive>
                  </span>
                </span>
                <span className='border border-border-hard px-3 py-2 text-[13px] text-fg'>{u}</span>
              </div>
            ))}
          </div>
          <span className='pt-2 text-[11px] text-fg-muted'>route</span>
          {results.map(r => (
            <RouteChoice
              key={r.route}
              result={r}
              unit={outUnit}
              on={r.route === quote?.route}
              best={r.route === best?.route}
              more={r.route === best?.route ? more : undefined}
              decimals={outDecimals}
              onPick={() => pickRoute(r.route)}
            />
          ))}
          {note && (
            <StatusSlot tone={quote.route === 'near' ? 'warn' : 'info'} icon='i-lucide-eye'>
              {note}
            </StatusSlot>
          )}
        </Main>
        <Footer>
          <Button
            className='w-full'
            onClick={() => setReviewOpen(true)}
            disabled={expired || !quote}
          >
            review swap
          </Button>
        </Footer>
        {quote && (
          <Sheet open={reviewOpen} onOpenChange={setReviewOpen} title='review swap'>
            <div className='flex flex-col gap-1.5 text-xs'>
              {/* only the amounts hide; the addresses and memo are what gets reviewed */}
              {(
                [
                  ['you send', `${quote.amountInText || amountIn} ${inUnit}`, true],
                  ['you receive', `${quote.amountOutText} ${outUnit}`, true],
                  ['route', ROUTES[quote.route].label],
                  [
                    'recipient',
                    isFromZec && otherName ? `${otherName} · ${quote.recipient}` : quote.recipient,
                  ],
                  [isFromZec ? 'deposit address' : 'pay to', quote.depositAddress],
                  ...(quote.memo ? [['memo', quote.memo]] : []),
                ] as [string, string, boolean?][]
              ).map(([k, v, amount]) => (
                <div key={k} className='flex justify-between gap-3'>
                  <span className='shrink-0 text-fg-muted'>{k}</span>
                  <span className='break-all text-right font-mono'>
                    {amount ? <Sensitive>{v}</Sensitive> : v}
                  </span>
                </div>
              ))}
              {quote.cost && <CostList cost={quote.cost} unit={outUnit} decimals={outDecimals} />}
            </div>
            {quote.route === best?.route && more && (
              <p className='text-xs text-fg-muted'>
                you get <Sensitive className='text-success'>{`${more} ${outUnit}`}</Sensitive> more
                than the next route
              </p>
            )}
            {quote.refundLine && <p className='text-xs text-fg-muted'>{quote.refundLine}</p>}
            <p className='text-xs text-fg-muted'>
              {ROUTES[quote.route].label} · {ROUTES[quote.route].custody}
              {quote.route === 'near' && (
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
            <label className='flex cursor-pointer items-start gap-2.5 text-xs text-fg'>
              <input
                type='checkbox'
                checked={riskAcknowledged}
                onChange={e => setRiskAcknowledged(e.target.checked)}
                className='mt-0.5 h-4 w-4 shrink-0 accent-[var(--zigner-gold)]'
              />
              i accept these risks.
            </label>
            {link?.via && <p className='text-[11px] text-fg-muted'>{viaLine(link.via)}</p>}
            <div className='flex gap-2'>
              <Button variant='secondary' className='flex-1' onClick={() => setReviewOpen(false)}>
                back
              </Button>
              <Button
                className='flex-1'
                onClick={() => void confirm()}
                disabled={!riskAcknowledged || expired}
              >
                {/* a memo deposit has its own reviews next; nothing is signed here */}
                {isFromZec ? (quote.memo ? 'continue' : 'confirm & send') : 'show deposit address'}
              </Button>
            </div>
          </Sheet>
        )}
        <Sheet
          open={expired}
          onOpenChange={open => !open && setStep('input')}
          title='this quote expired'
        >
          <p className='text-sm text-fg-muted'>
            rates move quickly, so a swap quote is only good for a short window. nothing was sent -
            your {inUnit} is still yours. get a fresh quote to continue.
          </p>
          <div className='mt-2 flex gap-2'>
            <Button variant='secondary' className='flex-1' onClick={() => setStep('input')}>
              not now
            </Button>
            <Button className='flex-1' onClick={() => void requestQuotes()}>
              get a new quote
            </Button>
          </div>
        </Sheet>
      </div>
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
          </div>
        )}

        {step === 'scan' && (
          <QrScanner
            onScan={data => void signatureScanned(data)}
            onError={err => {
              setError(typeof err === 'string' ? err : 'failed to scan signature');
              setStep('error');
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

        {(step === 'deposit' || step === 'polling') && quote && (
          <>
            {step === 'deposit' && !isFromZec && (
              <>
                {quote.memo && (
                  <div className='flex flex-col gap-2 border border-zigner-gold bg-zigner-gold/10 p-3'>
                    <span className='flex items-center justify-between'>
                      <span className='text-xs text-fg-high'>memo · required</span>
                      <CopyButton text={quote.memo} label='copy memo' />
                    </span>
                    <span className='break-all font-mono text-sm text-fg-high'>{quote.memo}</span>
                    {carrier && (
                      <span className='text-[11px] text-fg-muted'>{MEMO_HOW[carrier]}</span>
                    )}
                  </div>
                )}
                <div className='flex flex-col items-center gap-3 border border-border-soft bg-elev-1 p-3'>
                  <p className='text-xs text-fg-muted'>
                    send exactly <Sensitive>{`${quote.amountInText} ${inUnit}`}</Sensitive> on{' '}
                    {token?.chain} to
                  </p>
                  <QrCode value={quote.depositAddress} size={160} label='deposit address' />
                  {quote.gasLine && <p className='text-xs text-fg-muted'>{quote.gasLine}</p>}
                  <div className='flex w-full items-center gap-2'>
                    <span className='min-w-0 flex-1 break-all font-mono text-xs'>
                      {quote.depositAddress}
                    </span>
                    <CopyButton text={quote.depositAddress} label='copy' />
                  </div>
                </div>
              </>
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
            <Sensitive>{`${quote?.amountInText ?? ''} ${inUnit} - ${quote?.amountOutText ?? ''} ${outUnit}`}</Sensitive>
          </StatusSlot>
        )}
        {step === 'done' && quote?.cost && (
          <div className='flex flex-col gap-1.5 text-xs'>
            <CostList cost={quote.cost} unit={outUnit} decimals={outDecimals} />
          </div>
        )}

        {step === 'error' &&
          (isEgressBlocked(errorCause) ? (
            <EgressBlockedStatus error={errorCause} onAllowed={() => setStep('input')} />
          ) : (
            <StatusSlot tone='danger'>{error}</StatusSlot>
          ))}
      </Main>
      <Footer>
        {step === 'sign' && (
          <Button className='w-full' onClick={() => setStep('scan')}>
            scan signature
          </Button>
        )}
        {(step === 'deposit' || step === 'polling') &&
          (watchable ? (
            <Button variant='secondary' className='w-full' onClick={reset}>
              cancel
            </Button>
          ) : (
            <Button className='w-full' onClick={() => navigate(PopupPath.INDEX)}>
              done
            </Button>
          ))}
        {(step === 'done' || step === 'error') && (
          <Button className='w-full' onClick={reset}>
            {step === 'done' ? 'swap again' : 'try again'}
          </Button>
        )}
      </Footer>
    </div>
  );
};
