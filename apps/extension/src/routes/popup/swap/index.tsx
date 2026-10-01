/**
 * swap page
 *
 * penumbra: private on-chain DEX swap via simulation service
 * zcash: crosschain swap via NEAR 1Click (same API as Zashi mobile)
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { viewClient, simulationClient } from '../../../clients';
import { StepList } from '@repo/ui/components/ui/step-list';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { CopyButton } from '@repo/ui/components/ui/copy-button';
import { QrCode } from '../../../components/qr-code';
import { Sensitive } from '../../../components/sensitive';
import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectPenumbraAccount,
  selectEffectiveKeyInfo,
  selectGetVaultUnlock,
} from '../../../state/keyring';
import { contactsSelector, type ContactNetwork } from '../../../state/contacts';
import { isEgressBlocked } from '../../../net/egress';
import { EgressBlockedStatus } from '../../../shared/components/egress-blocked-status';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { Value, Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import {
  getAssetIdFromValueView,
  getDisplayDenomExponentFromValueView,
} from '@penumbra-zone/getters/value-view';
import { symbolFromMetadata } from '../../../utils/asset-display';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { isFungibleMetadata, selectPickerBuckets } from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import { cn } from '@repo/ui/lib/utils';
import { useActiveAddress } from '../../../hooks/use-address';
import {
  getBalanceInWorker,
  buildSendTxInWorker,
  completeSendTxInWorker,
} from '../../../state/keyring/network-worker';
import { RecipientPicker } from '../../../components/recipient-picker';
import {
  getSupportedTokens,
  requestQuote,
  checkSwapStatus,
  filterSwappableTokens,
  findZecAssetId,
  blockchainToContactNetwork,
  toBaseUnits,
  type NearToken,
  type SwapQuoteResponse,
  type SwapStatus,
} from '../../../state/near-swap';
import type {
  BalancesResponse,
  AssetsResponse,
} from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { usePasswordGate } from '../../../hooks/password-gate';
import { QrDisplay } from '../../../shared/components/qr-display';
import { QrScanner } from '../../../shared/components/qr-scanner';
import {
  encodeZcashSignRequest,
  parseZcashSignatureResponse,
  isZcashSignatureQR,
  hexToBytes,
  bytesToHex,
} from '@repo/wallet/networks';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { useBackNav } from '../../../utils/navigate';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { ScreenHeader } from '../../../components/screen-header';
import { PenumbraFlow } from '../send/penumbra-flow';
import { Footer, Main } from '../send/send-ui';
import { AmountField, PickSheet } from '../send/send-fields';
import { BalanceSheet } from '../send/balance-sheet';
import { PopupPath } from '../paths';
import { useLocation } from 'react-router-dom';
import { hasFeature } from '../../../config/networks';

/**
 * Router state accepted by the swap page. Set from the row-level "Swap X"
 * quick-action on the home asset list so the from-leg boots pre-selected.
 */
interface SwapLocationState {
  /** Base denom of the asset to preselect as the FROM leg. Falls back to
   *  top-priority balance when the denom is not found. */
  prefillFromAsset?: string;
}

/** input asset with balance */
interface InputAsset {
  balance: BalancesResponse;
  symbol: string;
  amount: string;
  assetId: Uint8Array | undefined;
  exponent: number;
  metadata?: Metadata;
}

/** stable empty list so memo/effect deps don't churn while balances load */
const EMPTY_BALANCES: BalancesResponse[] = [];

/** output asset from assets list */
interface OutputAsset {
  response: AssetsResponse;
  symbol: string;
  assetId: Uint8Array | undefined;
  exponent: number;
  metadata?: Metadata;
}

export const SwapPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const location = useLocation();
  const swapState = location.state as SwapLocationState | undefined;

  // gate on the capability, not the chain: a network without swap has no page
  // here. Which implementation renders below is chain-specific routing.
  if (!hasFeature(activeNetwork, 'swap')) {
    return (
      <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
        <div className='bg-primary/10 p-4'>
          <span className='i-ph-shuffle h-8 w-8 text-zigner-gold' />
        </div>
        <div>
          <h2 className='text-lg'>swap</h2>
          <p className='mt-1 text-sm text-fg-muted'>swapping is not available for this network.</p>
        </div>
      </div>
    );
  }

  if (activeNetwork === 'zcash') {
    return <ZcashCrosschainSwap />;
  }
  return <PenumbraSwap prefillFromAsset={swapState?.prefillFromAsset} />;
};

// ── Zcash Crosschain Swap (NEAR 1Click) ──

type ZcashSwapStep =
  | 'input'
  | 'quoting'
  | 'review'
  | 'sign'
  | 'scan'
  | 'sending'
  | 'deposit'
  | 'polling'
  | 'done'
  | 'error';

function LiveTimer({ startMs }: { startMs: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startMs) {
      return;
    }
    const tick = () => setElapsed(Math.round((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);

  return <div className='font-mono text-2xl tabular-nums text-zigner-gold'>{elapsed}s</div>;
}

const ZcashCrosschainSwap = () => {
  const goBack = useBackNav(PopupPath.INDEX);
  const { address: zcashAddress } = useActiveAddress();
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { contacts } = useStore(contactsSelector);
  const [step, setStep] = useState<ZcashSwapStep>('input');
  const [direction, setDirection] = useState<'from_zec' | 'into_zec'>('into_zec');
  const [amountIn, setAmountIn] = useState('');
  const [selectedToken, setSelectedToken] = useState<NearToken | undefined>();
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [destinationAddress, setDestinationAddress] = useState('');
  const [showContacts, setShowContacts] = useState(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [quote, setQuote] = useState<SwapQuoteResponse | undefined>();
  const [swapStatus, setSwapStatus] = useState<SwapStatus | null>(null);
  const [error, setError] = useState<string | undefined>();
  // kept alongside the message so a blocked destination can offer an inline
  // allow instead of a generic "swap failed" (see EgressBlockedStatus below)
  const [errorCause, setErrorCause] = useState<unknown>();
  const [balanceZec, setBalanceZec] = useState<string | undefined>();
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const { requestAuth, PasswordModal } = usePasswordGate();
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const unsignedTxRef = useRef<any | null>(null);
  const [sendSteps, setSendSteps] = useState<
    { step: string; detail?: string; elapsedMs: number }[]
  >([]);
  const buildStartRef = useRef(0);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const ufvk =
    activeZcashWallet?.ufvk ??
    (activeZcashWallet?.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);

  const isFromZec = direction === 'from_zec';

  //zcash-send-progress
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

  // fetch ZEC balance
  const walletId = selectedKeyInfo?.id;
  useEffect(() => {
    if (!walletId) {
      return;
    }
    getBalanceInWorker('zcash', walletId)
      .then(b => {
        const zec = (Number(b) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        setBalanceZec(zec);
      })
      .catch(() => {});
  }, [walletId]);

  // supported tokens + the ZEC asset id, fetched only when the user acts (opens
  // the token picker or asks for a quote), never merely from opening swap. That
  // first fetch is what the egress ask sheet waits on.
  const tokenQuery = useQuery({
    queryKey: ['near-tokens'],
    staleTime: 300_000,
    enabled: tokenPickerOpen,
    queryFn: async () => {
      const all = await getSupportedTokens();
      return { swappable: filterSwappableTokens(all), zecAssetId: findZecAssetId(all) };
    },
  });
  const tokens = tokenQuery.data?.swappable ?? [];
  const tokensLoading = tokenQuery.isFetching;

  // popular tokens first
  const sortedTokens = useMemo(() => {
    const popular = ['BTC', 'ETH', 'USDC', 'USDT', 'SOL', 'NEAR'];
    return [...tokens].sort((a, b) => {
      const ai = popular.indexOf(a.symbol);
      const bi = popular.indexOf(b.symbol);
      if (ai >= 0 && bi >= 0) {
        return ai - bi;
      }
      if (ai >= 0) {
        return -1;
      }
      if (bi >= 0) {
        return 1;
      }
      return a.symbol.localeCompare(b.symbol);
    });
  }, [tokens]);

  // map selected token's blockchain to contact network for address book
  const destContactNetwork = useMemo(() => {
    if (!selectedToken) {
      return undefined;
    }
    return blockchainToContactNetwork(selectedToken.blockchain) as ContactNetwork | undefined;
  }, [selectedToken]);

  // get contacts for the destination network
  const destContacts = useMemo(() => {
    if (!destContactNetwork) {
      return [];
    }
    return contacts
      .filter(c => c.addresses.some(a => a.network === destContactNetwork))
      .flatMap(c =>
        c.addresses
          .filter(a => a.network === destContactNetwork)
          .map(a => ({ name: c.name, address: a.address })),
      );
  }, [contacts, destContactNetwork]);

  const handleFlipDirection = useCallback(() => {
    if (step !== 'input') {
      return;
    }
    setDirection(d => (d === 'from_zec' ? 'into_zec' : 'from_zec'));
    setAmountIn('');
    setDestinationAddress('');
  }, [step]);

  const handleRequestQuote = useCallback(async () => {
    if (!selectedToken) {
      setError('select a token to receive');
      return;
    }

    if (!amountIn || parseFloat(amountIn) <= 0) {
      setError('enter an amount greater than 0');
      return;
    }

    if (!zcashAddress) {
      setError('zcash address not loaded yet');
      return;
    }

    const zecAssetId = tokenQuery.data?.zecAssetId ?? (await tokenQuery.refetch()).data?.zecAssetId;
    if (!zecAssetId) {
      setError('the swap service did not answer · please try again');
      return;
    }

    if (!destinationAddress) {
      setError(
        isFromZec
          ? `enter ${selectedToken.blockchain} recipient address`
          : `enter your ${selectedToken.blockchain} address for sending + refund`,
      );
      return;
    }

    setStep('quoting');
    setError(undefined);

    try {
      const originAsset = isFromZec ? zecAssetId : selectedToken.assetId;
      const destAsset = isFromZec ? selectedToken.assetId : zecAssetId;
      const originDecimals = isFromZec ? 8 : selectedToken.decimals;
      const amount = toBaseUnits(amountIn, originDecimals);

      const recipient = isFromZec ? destinationAddress : zcashAddress;
      const refundTo = isFromZec ? zcashAddress : destinationAddress;

      const resp = await requestQuote({
        swapType: 'EXACT_INPUT',
        amount,
        originAsset,
        destinationAsset: destAsset,
        recipient,
        refundTo,
      });

      setQuote(resp);
      setStep('review');
    } catch (err) {
      setErrorCause(err);
      setError(err instanceof Error ? err.message : 'failed to get quote');
      setStep('error');
    }
  }, [selectedToken, amountIn, zcashAddress, tokenQuery, destinationAddress, isFromZec]);

  const handleConfirmSwap = useCallback(async () => {
    if (!quote || !selectedKeyInfo) {
      return;
    }

    setError(undefined);

    // into zcash: the user pays the deposit address from their other wallet;
    // zafu only shows it and watches for the swap to land
    if (!isFromZec) {
      setStep('deposit');
      return;
    }

    try {
      if (selectedKeyInfo.type === 'mnemonic') {
        const ok = await requestAuth();
        if (!ok) {
          setStep('review');
          return;
        }

        setSendSteps([]);
        buildStartRef.current = Date.now();
        setStep('sending');

        const walletId = selectedKeyInfo.id;
        const amountZat = toBaseUnits(amountIn, 8);
        const vault = await getVaultUnlock(walletId);

        const result = await buildSendTxInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          quote.quote.depositAddress,
          amountZat,
          '',
          0,
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
      const walletId = selectedKeyInfo.id;
      const amountZat = toBaseUnits(amountIn, 8);

      // build unsigned tx
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
        quote.quote.depositAddress,
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

      // build QR
      const signRequest = encodeZcashSignRequest({
        accountIndex: 0,
        sighash: hexToBytes(result.sighash),
        orchardAlphas: result.alphas.map(a => hexToBytes(a)),
        summary: `swap ${amountIn} ZEC`,
        mainnet: true,
      });

      setSignRequestQr(signRequest);
      setStep('sign');
    } catch (err) {
      console.error('[swap] send failed', err);
      setErrorCause(err);
      setError(err instanceof Error ? err.message : 'failed to send deposit');
      setStep('error');
    }
  }, [quote, selectedKeyInfo, amountIn, getVaultUnlock, zidecarUrl, isFromZec, requestAuth]);

  const handleSignatureScanned = useCallback(
    async (data: string) => {
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

        const signatures = {
          orchardSigs: sigResponse.orchardSigs.map(bytesToHex),
          transparentSigs: sigResponse.transparentSigs.map(bytesToHex),
        };

        setStep('sending');

        const result = await completeSendTxInWorker(
          'zcash',
          selectedKeyInfo.id,
          zidecarUrl,
          unsignedTxRef.current.unsignedTx,
          signatures,
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
    },
    [selectedKeyInfo, zidecarUrl],
  );

  // poll swap status when in deposit/polling step
  useEffect(() => {
    if ((step !== 'deposit' && step !== 'polling') || !quote) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const status = await checkSwapStatus(quote.quote.depositAddress);

        console.log('[swap-status]', status.status);
        setSwapStatus(status.status);

        switch (status.status) {
          case 'SUCCESS':
            setStep('done');
            break;

          case 'FAILED':
          case 'REFUNDED':
            setError(`swap ${status.status.toLowerCase()}`);
            setStep('error');
            break;

          case 'PROCESSING':
            setStep('polling');
            break;

          case 'KNOWN_DEPOSIT_TX':
          case 'PENDING_DEPOSIT':
          case 'INCOMPLETE_DEPOSIT':
          case null:
          default:
            // stay on current screen and keep polling
            break;
        }
      } catch (err) {
        console.error('[swap-status] poll failed', err);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [step, quote]);
  const handleReset = useCallback(() => {
    setStep('input');
    setQuote(undefined);
    setSwapStatus(null);
    setError(undefined);
    setAmountIn('');
  }, []);

  const canQuote = selectedToken && parseFloat(amountIn) > 0 && zcashAddress && destinationAddress;

  // a quote is only good for a short window - watch for it passing while the
  // user is still reviewing, so nothing is sent against a stale rate
  const [quoteExpired, setQuoteExpired] = useState(false);
  useEffect(() => {
    setQuoteExpired(false);
    const deadline = quote?.quote.deadline;
    if (step !== 'review' || !deadline) {
      return;
    }
    const ms = new Date(deadline).getTime() - Date.now();
    if (ms <= 0) {
      setQuoteExpired(true);
      return;
    }
    const id = setTimeout(() => setQuoteExpired(true), ms);
    return () => clearTimeout(id);
  }, [step, quote]);

  return (
    <div className='flex flex-col gap-3 p-4'>
      {PasswordModal}
      {/* header with back arrow */}
      <div className='flex items-center gap-3 -mx-4 -mt-4 border-b border-border-soft px-4 py-3'>
        <button onClick={goBack} className='text-fg-muted transition-colors hover:text-fg-high'>
          <span className='i-ph-arrow-left h-5 w-5' />
        </button>
        <h1 className='text-lg'>crosschain swap</h1>
      </div>

      {step === 'input' && (
        <>
          {/* FROM card */}
          <div className='border border-border-soft bg-elev-2/20 p-3'>
            <div className='flex items-center justify-between mb-2'>
              <span className='text-xs text-fg-muted'>you send</span>
              {isFromZec && balanceZec && (
                <button
                  onClick={() => {
                    const max = Math.max(0, parseFloat(balanceZec) - 0.0001);
                    setAmountIn(max.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
                  }}
                  className='text-xs text-fg-muted hover:text-fg-high'
                >
                  bal: <Sensitive>{parseFloat(balanceZec).toFixed(4)}</Sensitive>
                </button>
              )}
            </div>
            <div className='flex items-center gap-2'>
              <input
                type='text'
                inputMode='decimal'
                value={amountIn}
                onChange={e => setAmountIn(e.target.value)}
                placeholder='0.00'
                className='flex-1 bg-transparent text-xl text-fg placeholder:text-fg-muted focus:outline-none'
              />
              {isFromZec ? (
                <div className='shrink-0 bg-elev-2 px-3 py-1.5 text-sm'>ZEC</div>
              ) : (
                <button
                  onClick={() => setTokenPickerOpen(!tokenPickerOpen)}
                  disabled={tokensLoading}
                  className='shrink-0 flex items-center gap-1 bg-elev-2 px-3 py-1.5 text-sm transition-colors hover:bg-elev-1/80 disabled:opacity-50'
                >
                  {tokensLoading ? '...' : (selectedToken?.symbol ?? 'select')}
                  <span
                    className={cn(
                      'i-ph-caret-down h-3.5 w-3.5 transition-transform',
                      tokenPickerOpen && 'rotate-180',
                    )}
                  />
                </button>
              )}
            </div>
          </div>

          {/* flip arrow */}
          <div className='flex justify-center -my-1.5 z-10'>
            <button
              onClick={handleFlipDirection}
              className='border border-border-soft bg-canvas p-1.5 shadow-sm transition-colors hover:bg-elev-1'
              title='flip direction'
            >
              <div className='flex flex-col items-center'>
                <span className='i-ph-arrow-down h-4 w-4' />
              </div>
            </button>
          </div>

          {/* TO card */}
          <div className='border border-border-soft bg-elev-2/20 p-3'>
            <div className='flex items-center justify-between mb-2'>
              <span className='text-xs text-fg-muted'>you receive</span>
            </div>
            <div className='flex items-center gap-2'>
              <div className='flex-1 text-xl text-fg-muted/50'>--</div>
              {isFromZec ? (
                <button
                  onClick={() => setTokenPickerOpen(!tokenPickerOpen)}
                  disabled={tokensLoading}
                  className='shrink-0 flex items-center gap-1 bg-elev-2 px-3 py-1.5 text-sm transition-colors hover:bg-elev-1/80 disabled:opacity-50'
                >
                  {tokensLoading ? '...' : (selectedToken?.symbol ?? 'select')}
                  <span
                    className={cn(
                      'i-ph-caret-down h-3.5 w-3.5 transition-transform',
                      tokenPickerOpen && 'rotate-180',
                    )}
                  />
                </button>
              ) : (
                <div className='shrink-0 bg-elev-2 px-3 py-1.5 text-sm'>ZEC</div>
              )}
            </div>
            {selectedToken && (
              <div className='mt-1 text-xs text-fg-muted'>on {selectedToken.blockchain}</div>
            )}
          </div>

          {/* token picker dropdown */}
          {tokenPickerOpen && (
            <div className='border border-border-soft bg-canvas max-h-48 overflow-y-auto -mt-2'>
              {sortedTokens.map(t => (
                <button
                  key={t.assetId}
                  onClick={() => {
                    setSelectedToken(t);
                    setTokenPickerOpen(false);
                    setDestinationAddress('');
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-elev-1',
                    selectedToken?.assetId === t.assetId && 'bg-elev-2',
                  )}
                >
                  <span>{t.symbol}</span>
                  <span className='text-xs text-fg-muted'>{t.blockchain}</span>
                </button>
              ))}
              {sortedTokens.length === 0 && (
                <div className='px-3 py-2 text-sm text-fg-muted'>no tokens available</div>
              )}
            </div>
          )}

          {/* destination address */}
          <div className='border border-border-soft bg-elev-2/20 p-3'>
            <div className='flex items-center justify-between mb-1'>
              <span className='text-xs text-fg-muted'>
                {isFromZec
                  ? `${selectedToken?.blockchain ?? 'destination'} recipient`
                  : `your ${selectedToken?.blockchain ?? 'source'} address`}
              </span>
              {destContacts.length > 0 && (
                <button
                  onClick={() => setShowContacts(!showContacts)}
                  className={cn(
                    'p-0.5 transition-colors',
                    showContacts ? 'text-fg' : 'text-fg-muted hover:text-fg-high',
                  )}
                  title='address book'
                >
                  <span className='i-ph-user h-3.5 w-3.5' />
                </button>
              )}
            </div>
            <input
              type='text'
              value={destinationAddress}
              onChange={e => {
                setDestinationAddress(e.target.value);
                setShowContacts(false);
              }}
              placeholder={isFromZec ? 'recipient address' : 'your address (for sending + refund)'}
              className='w-full bg-transparent text-sm font-mono text-fg placeholder:text-fg-muted focus:outline-none'
            />
            {/* contact book suggestions */}
            {showContacts && destContacts.length > 0 && (
              <div className='mt-2 flex flex-wrap gap-1'>
                {destContacts.map(c => (
                  <button
                    key={c.address}
                    onClick={() => {
                      setDestinationAddress(c.address);
                      setShowContacts(false);
                    }}
                    className='bg-elev-2 px-2 py-1 text-xs text-fg-muted hover:bg-elev-1/80 hover:text-fg-high transition-colors'
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
            {/* also show RecipientPicker for matching network */}
            {destContactNetwork && !showContacts && (
              <RecipientPicker
                network={destContactNetwork}
                onSelect={addr => setDestinationAddress(addr)}
                show={!destinationAddress}
              />
            )}
          </div>

          {error && <p className='text-xs text-red-400'>{error}</p>}

          <button
            onClick={() => void handleRequestQuote()}
            disabled={!canQuote}
            className={cn(
              'w-full bg-zigner-gold py-3 text-sm text-zigner-gold-foreground',
              'transition-colors hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            get quote
          </button>
        </>
      )}

      {step === 'quoting' && (
        <div className='flex flex-col items-center gap-3 py-12'>
          <span className='i-ph-arrows-clockwise h-6 w-6 animate-spin text-fg-muted' />
          <p className='text-sm text-fg-muted'>fetching quote...</p>
        </div>
      )}

      {step === 'review' && quote && (
        <div className='flex flex-col gap-3'>
          <div className='border border-zigner-gold/30 bg-card/50 p-3'>
            <p className='mb-2 text-xs text-zigner-gold'>confirm swap</p>

            <div className='flex flex-col gap-1.5 text-xs'>
              <div className='flex justify-between'>
                <span className='text-fg-muted'>you send</span>
                <span>
                  <Sensitive>{amountIn} ZEC</Sensitive>
                </span>
              </div>

              <div className='flex justify-between'>
                <span className='text-fg-muted'>you receive</span>
                <span>
                  <Sensitive>
                    {quote.quote.amountOutFormatted} {isFromZec ? selectedToken?.symbol : 'ZEC'}
                  </Sensitive>
                </span>
              </div>

              <div className='flex justify-between gap-2'>
                <span className='shrink-0 text-fg-muted'>recipient</span>
                <span className='break-all text-right font-mono'>{destinationAddress}</span>
              </div>

              <div className='flex justify-between gap-2'>
                <span className='shrink-0 text-fg-muted'>deposit address</span>
                <span className='break-all text-right font-mono'>{quote.quote.depositAddress}</span>
              </div>
            </div>

            {/* third-party custody risk: one quiet line at the moment of commitment */}
            <p className='mt-3 text-xs text-fg-muted'>
              near intents · a solver holds funds briefly ·{' '}
              <a
                href='https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-terms-of-service'
                target='_blank'
                rel='noopener noreferrer'
                className='underline underline-offset-2 hover:text-fg-high'
              >
                terms
              </a>
            </p>
            <label className='mt-2 flex cursor-pointer items-start gap-2.5 text-xs text-fg'>
              <input
                type='checkbox'
                checked={riskAcknowledged}
                onChange={e => setRiskAcknowledged(e.target.checked)}
                className='mt-0.5 h-4 w-4 shrink-0 accent-[var(--zigner-gold)]'
              />
              i accept these risks.
            </label>

            <div className='mt-3 flex gap-2'>
              <button
                onClick={() => void handleConfirmSwap()}
                disabled={!riskAcknowledged}
                className='flex-1 bg-zigner-gold py-3 text-sm text-zigner-gold-foreground transition-colors hover:bg-zigner-gold-light disabled:cursor-not-allowed disabled:opacity-50'
              >
                {isFromZec ? 'confirm & send' : 'show deposit address'}
              </button>

              <button
                onClick={() => setStep('input')}
                className='flex-1 border border-border-soft py-3 text-sm text-fg-muted transition-colors hover:text-fg-high'
              >
                back
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'sign' && signRequestQr && (
        <div className='flex flex-col gap-4 p-4'>
          <div className='flex flex-col items-center gap-4 py-4'>
            <QrDisplay
              data={signRequestQr}
              size={220}
              title='scan with zigner'
              description='scan this QR with your signer'
            />
          </div>

          <div className='text-center'>
            <p className='text-sm text-fg-muted'>1. open zigner on your phone</p>
            <p className='text-sm text-fg-muted'>2. scan this qr code</p>
            <p className='text-sm text-fg-muted'>3. review and approve the transaction</p>
          </div>

          <button
            onClick={() => setStep('scan')}
            className='w-full bg-zigner-gold py-3 text-sm text-zigner-gold-foreground transition-colors hover:bg-zigner-gold-light'
          >
            scan signature
          </button>
        </div>
      )}

      {step === 'scan' && (
        <QrScanner
          onScan={handleSignatureScanned}
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
        <div className='flex flex-col items-center gap-4 p-6'>
          <div className='w-16 h-16 bg-primary/20 flex items-center justify-center'>
            <div className='w-8 h-8 border-2 border-zigner-gold border-t-transparent animate-spin' />
          </div>
          <h2 className='text-lg'>building transaction</h2>

          <LiveTimer startMs={buildStartRef.current} />

          <StepList steps={sendSteps} className='w-full max-w-sm' />
        </div>
      )}

      {(step === 'deposit' || step === 'polling') && quote && (
        <div className='flex flex-col gap-3'>
          {/* quote summary */}
          <div className='border border-border-soft bg-elev-2/20 p-3'>
            <div className='flex justify-between text-sm'>
              <span className='text-fg-muted'>send</span>
              <span>
                <Sensitive>
                  {quote.quote.amountInFormatted} {isFromZec ? 'ZEC' : selectedToken?.symbol}
                </Sensitive>
              </span>
            </div>
            <div className='flex justify-between text-sm mt-1'>
              <span className='text-fg-muted'>receive</span>
              <span>
                <Sensitive>
                  {quote.quote.amountOutFormatted} {isFromZec ? selectedToken?.symbol : 'ZEC'}
                </Sensitive>
              </span>
            </div>
            {quote.quote.amountInUsd !== '0' && (
              <div className='flex justify-between text-xs text-fg-muted mt-1'>
                <span>value</span>
                <span>
                  $<Sensitive>{parseFloat(quote.quote.amountInUsd).toFixed(2)}</Sensitive>
                </span>
              </div>
            )}
          </div>

          {/* into zcash: pay this address from the other wallet */}
          {!isFromZec && step === 'deposit' && (
            <div className='flex flex-col items-center gap-3 border border-border-soft bg-elev-2/20 p-3'>
              <p className='text-xs text-fg-muted'>
                send exactly {quote.quote.amountInFormatted} {selectedToken?.symbol} on{' '}
                {selectedToken?.blockchain} to
              </p>
              <QrCode value={quote.quote.depositAddress} size={160} label='deposit address' />
              <div className='flex w-full items-center gap-2'>
                <span className='min-w-0 flex-1 break-all font-mono text-xs'>
                  {quote.quote.depositAddress}
                </span>
                <CopyButton text={quote.quote.depositAddress} label='copy' />
              </div>
            </div>
          )}

          {/* status */}
          <div className='border border-border-soft bg-elev-2/20 p-3'>
            <div className='flex items-center gap-2'>
              {step === 'polling' ? (
                <span className='i-ph-arrows-clockwise h-4 w-4 animate-spin text-zigner-gold' />
              ) : (
                <div className='h-2 w-2 bg-yellow-500 animate-pulse' />
              )}
              <span className='text-sm'>
                {swapStatus === 'PROCESSING' && 'processing swap...'}
                {swapStatus === 'PENDING_DEPOSIT' && 'waiting for deposit...'}
                {swapStatus === 'KNOWN_DEPOSIT_TX' && 'deposit detected, confirming...'}
                {swapStatus === 'INCOMPLETE_DEPOSIT' && 'waiting for full deposit...'}
                {!swapStatus && 'waiting for deposit...'}
              </span>
            </div>
          </div>

          <button onClick={handleReset} className='text-xs text-fg-muted hover:text-fg-high'>
            cancel
          </button>
        </div>
      )}

      {step === 'done' && (
        <div className='flex flex-col gap-3'>
          <div className='border border-green-500/40 bg-green-500/10 p-3'>
            <p className='text-sm text-green-400'>swap complete</p>
            {quote && (
              <p className='text-xs text-fg-muted mt-1'>
                <Sensitive>
                  {quote.quote.amountInFormatted} {isFromZec ? 'ZEC' : selectedToken?.symbol}
                </Sensitive>
                {' → '}
                <Sensitive>
                  {quote.quote.amountOutFormatted} {isFromZec ? selectedToken?.symbol : 'ZEC'}
                </Sensitive>
              </p>
            )}
          </div>
          <button
            onClick={handleReset}
            className='w-full bg-zigner-gold py-3 text-sm text-zigner-gold-foreground transition-colors hover:bg-primary/90'
          >
            swap again
          </button>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          {isEgressBlocked(errorCause) ? (
            <EgressBlockedStatus error={errorCause} onAllowed={() => setStep('input')} />
          ) : (
            <div className='border border-red-500/40 bg-red-500/10 p-3'>
              <p className='text-sm text-red-400'>swap failed</p>
              <p className='text-xs text-fg-muted mt-1'>{error}</p>
            </div>
          )}
          <button
            onClick={handleReset}
            className='w-full bg-zigner-gold py-3 text-sm text-zigner-gold-foreground transition-colors hover:bg-primary/90'
          >
            try again
          </button>
        </div>
      )}

      <Sheet
        open={quoteExpired && step === 'review'}
        onOpenChange={open => {
          if (!open) {
            setStep('input');
          }
        }}
        title='quote expired'
      >
        <p className='text-sm text-fg-muted'>
          rates move quickly, so a swap quote is only good for a short window. nothing was sent -
          your {isFromZec ? 'zec' : selectedToken?.symbol.toLowerCase()} is still yours. get a fresh
          quote to continue.
        </p>
        <div className='mt-2 flex gap-2'>
          <Button variant='secondary' className='flex-1' onClick={() => setStep('input')}>
            not now
          </Button>
          <Button
            className='flex-1'
            onClick={() => {
              setStep('input');
              void handleRequestQuote();
            }}
          >
            get a new quote
          </Button>
        </div>
      </Sheet>
    </div>
  );
};

// ── Penumbra DEX Swap ──

const PenumbraSwap = ({ prefillFromAsset }: { prefillFromAsset?: string } = {}) => {
  const goBack = useBackNav(PopupPath.INDEX);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [amountIn, setAmountIn] = useState('');
  const [pick, setPick] = useState<'in' | 'out'>();
  const [selectedIn, setSelectedIn] = useState<InputAsset | undefined>();
  const [selectedOut, setSelectedOut] = useState<OutputAsset | undefined>();

  // fetch balances
  // The ['balances', account] cache holds the RAW list (the home screen
  // preloads it); `select` buckets it per observer, so the picker filter
  // applies no matter who populated the cache.
  const {
    data: buckets,
    isLoading: balancesLoading,
    refetch: refetchBalances,
  } = useQuery({
    ...balancesQueryOptions(penumbraAccount),
    staleTime: 30_000,
    select: selectPickerBuckets,
  });
  const balances = buckets?.assets ?? EMPTY_BALANCES;
  const { data: allAssets = [], isLoading: assetsLoading } = useQuery({
    queryKey: ['assets'],
    staleTime: 300_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.assets({}));
        return raw
          .filter(resp => isFungibleMetadata(resp.denomMetadata))
          .sort((a, b) =>
            Number((b.denomMetadata?.priorityScore ?? 0n) - (a.denomMetadata?.priorityScore ?? 0n)),
          );
      } catch {
        return [];
      }
    },
  });

  const inputAssets: InputAsset[] = useMemo(() => {
    return balances.map(b => {
      const metadata = getMetadataFromBalancesResponse.optional(b);
      const symbol = symbolFromMetadata(metadata);
      const amt = b.balanceView ? fromValueView(b.balanceView) : 0;
      const amount = typeof amt === 'string' ? amt : amt.toString();
      const assetId = b.balanceView ? getAssetIdFromValueView(b.balanceView)?.inner : undefined;
      const exponent = b.balanceView ? getDisplayDenomExponentFromValueView(b.balanceView) : 6;
      return { balance: b, symbol, amount, assetId, exponent, metadata };
    });
  }, [balances]);

  const outputAssets: OutputAsset[] = useMemo(() => {
    return allAssets.map(resp => {
      const meta = resp.denomMetadata;
      const symbol = symbolFromMetadata(meta);
      const assetId = meta?.penumbraAssetId?.inner;
      const exponent = meta?.denomUnits?.find(u => u.denom === meta?.display)?.exponent ?? 6;
      return { response: resp, symbol, assetId, exponent, metadata: meta };
    });
  }, [allAssets]);

  // Auto-select the FROM leg. If the row-level "Swap X" quick-action passed
  // a base denom, prefer the matching input asset; fall back to the
  // top-priority balance so the form is never empty when the user has funds.
  useEffect(() => {
    if (selectedIn || inputAssets.length === 0) {
      return;
    }
    const match = prefillFromAsset
      ? inputAssets.find(a => a.metadata?.base === prefillFromAsset)
      : undefined;
    setSelectedIn(match ?? inputAssets[0]);
  }, [inputAssets, selectedIn, prefillFromAsset]);

  const {
    data: simulation,
    isLoading: simLoading,
    error: simError,
  } = useQuery({
    queryKey: ['simulate', selectedIn?.assetId, selectedOut?.assetId, amountIn],
    enabled: !!selectedIn && !!selectedOut && parseFloat(amountIn) > 0,
    staleTime: 10_000,
    queryFn: async () => {
      if (!selectedIn || !selectedOut || !amountIn || parseFloat(amountIn) <= 0) {
        return null;
      }

      const multiplier = 10 ** selectedIn.exponent;
      const baseAmount = BigInt(Math.floor(parseFloat(amountIn) * multiplier));

      const inputValue = new Value({
        amount: new Amount({ lo: baseAmount, hi: 0n }),
        assetId: { inner: selectedIn.assetId },
      });

      const result = await simulationClient.simulateTrade({
        input: inputValue,
        output: { inner: selectedOut.assetId },
      });

      const execution = result.output;
      if (!execution) {
        return null;
      }

      let totalOutput = 0n;
      for (const trace of execution.traces ?? []) {
        const outputValue = trace.value?.at(-1);
        if (outputValue?.amount) {
          totalOutput += outputValue.amount.lo ?? 0n;
        }
      }

      const outputAmount = Number(totalOutput) / 10 ** selectedOut.exponent;

      // Penumbra always returns an `unfilled` Value; it only means a partial
      // fill when its amount is > 0 (input that couldn't fill at the price and
      // is returned to you). Guarding on the object alone flagged every swap.
      const unfilledAmt = result.unfilled?.amount;
      const unfilledLo = unfilledAmt?.lo ?? 0n;
      const hasUnfilled = unfilledLo > 0n || (unfilledAmt?.hi ?? 0n) > 0n;

      // Effective price against the *filled* portion only: the input that was
      // returned unfilled never traded, so rating it against the full input
      // would understate the rate you actually got.
      const inputAmount = parseFloat(amountIn);
      const filledInput = inputAmount - Number(unfilledLo) / 10 ** selectedIn.exponent;
      const rate = filledInput > 0 ? outputAmount / filledInput : 0;

      return {
        outputAmount: outputAmount.toFixed(6),
        rate: rate > 0 ? rate : undefined,
        unfilled: hasUnfilled
          ? {
              amount: (Number(unfilledLo) / 10 ** selectedIn.exponent).toFixed(6),
              symbol: selectedIn.symbol,
            }
          : undefined,
      };
    },
  });

  const handleMax = useCallback(() => {
    if (selectedIn) {
      setAmountIn(selectedIn.amount);
    }
  }, [selectedIn]);

  const handleFlip = useCallback(() => {
    if (selectedIn && selectedOut) {
      const newIn = inputAssets.find(
        a =>
          a.assetId &&
          a.assetId.length === selectedOut.assetId?.length &&
          a.assetId.every((v, i) => v === selectedOut.assetId![i]),
      );
      if (newIn) {
        const newOut = outputAssets.find(
          a =>
            a.assetId &&
            a.assetId.length === selectedIn.assetId?.length &&
            a.assetId.every((v, i) => v === selectedIn.assetId![i]),
        );
        if (newOut) {
          setSelectedIn(newIn);
          setSelectedOut(newOut);
          setAmountIn('');
        }
      }
    }
  }, [selectedIn, selectedOut, inputAssets, outputAssets]);

  const canReview = !!selectedIn && !!selectedOut && parseFloat(amountIn) > 0 && !!simulation;

  const plan = async () => {
    const baseAmount = BigInt(Math.floor(parseFloat(amountIn) * 10 ** selectedIn!.exponent));
    const { address: claimAddress } = await viewClient.addressByIndex({
      addressIndex: { account: penumbraAccount },
    });
    return new TransactionPlannerRequest({
      swaps: [
        {
          targetAsset: { inner: selectedOut!.assetId },
          value: new Value({
            amount: new Amount({ lo: baseAmount, hi: 0n }),
            assetId: { inner: selectedIn!.assetId },
          }),
          claimAddress,
        },
      ],
      source: { account: penumbraAccount },
    });
  };

  const unitIn = (selectedIn?.symbol ?? 'um').toLowerCase();
  const unitOut = (selectedOut?.symbol ?? 'asset').toLowerCase();
  const rate =
    simulation?.rate &&
    `1 ${unitIn} = ${
      simulation.rate < 0.001
        ? simulation.rate.toPrecision(3)
        : simulation.rate.toLocaleString(undefined, { maximumFractionDigits: 6 })
    } ${unitOut}`;
  const line = (
    <>
      <Sensitive>{`${amountIn} ${unitIn}`}</Sensitive> for about{' '}
      <Sensitive>{`${simulation?.outputAmount ?? '0'} ${unitOut}`}</Sensitive>
    </>
  );
  const sameAsIn = (a: OutputAsset) =>
    !!selectedIn?.assetId &&
    !!a.assetId &&
    selectedIn.assetId.length === a.assetId.length &&
    selectedIn.assetId.every((v, i) => v === a.assetId![i]);
  const outChoices = outputAssets.filter(a => !sameAsIn(a));

  return (
    <PenumbraFlow
      onClose={goBack}
      tx={{
        sending: <>swap {line}</>,
        label: `swap ${amountIn} ${selectedIn?.symbol ?? ''} for ${selectedOut?.symbol ?? ''}`,
        plan,
        onSent: () => {
          void refetchBalances();
          setAmountIn('');
        },
        review: {
          lead: 'you swap',
          amount: amountIn,
          unit: unitIn,
          rows: [
            ['you get about', `${simulation?.outputAmount ?? '0'} ${unitOut}`],
            ...(rate ? [['rate', rate] as const] : []),
            ['fee', 'shown before you approve'],
          ],
          privacy: 'shielded · the dex sees the batch, not you',
          confirm: 'swap',
        },
        done: <>{line} · it lands once the claim is processed</>,
      }}
    >
      {review => (
        <>
          <ScreenHeader title='swap' onBack={goBack} />
          <Main className='gap-[18px] pt-5'>
            <AmountField
              label='you pay'
              value={amountIn}
              onChange={setAmountIn}
              unit={balancesLoading ? 'reading' : unitIn}
              onUnit={() => setPick('in')}
              available={selectedIn?.amount}
              onMax={handleMax}
              canMax={!!selectedIn}
              autoFocus={!!prefillFromAsset}
              warn={!!simError}
              helper={
                simError
                  ? 'the dex could not price this right now · please try again'
                  : simulation?.unfilled
                    ? `only part fills at this price · ${simulation.unfilled.amount} ${simulation.unfilled.symbol.toLowerCase()} comes back`
                    : simLoading
                      ? 'pricing'
                      : rate
              }
            />
            <RowGroup>
              <Row
                type='value'
                label='you get'
                description={
                  selectedIn && selectedOut
                    ? `${simulation?.outputAmount ?? '0'} ${unitOut}`
                    : undefined
                }
                value={assetsLoading ? 'reading' : selectedOut ? unitOut : 'choose'}
                onPress={() => setPick('out')}
              />
            </RowGroup>
            {selectedIn && selectedOut && (
              <Button variant='quiet' size='sm' onClick={handleFlip} className='self-start px-0'>
                <span className='i-lucide-arrow-up-down size-3.5' />
                flip
              </Button>
            )}
          </Main>
          <Footer>
            <Button onClick={review} disabled={!canReview} className='w-full'>
              {simLoading ? 'pricing' : 'review swap'}
            </Button>
          </Footer>
          <BalanceSheet
            open={pick === 'in'}
            onOpenChange={o => setPick(o ? 'in' : undefined)}
            assets={balances}
            onPick={b => setSelectedIn(inputAssets.find(a => a.balance === b))}
          />
          <PickSheet
            title='you get'
            open={pick === 'out'}
            onOpenChange={o => setPick(o ? 'out' : undefined)}
            picks={outChoices.map((a, i) => ({ key: i, label: a.symbol }))}
            onPick={i => setSelectedOut(outChoices[i])}
          />
        </>
      )}
    </PenumbraFlow>
  );
};
