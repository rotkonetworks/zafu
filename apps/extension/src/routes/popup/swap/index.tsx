/**
 * swap page
 *
 * penumbra: private on-chain DEX swap via simulation service
 * zcash: crosschain swap via NEAR 1Click (same API as Zashi mobile)
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { viewClient, simulationClient } from '../../../clients';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectPenumbraAccount,
  selectEffectiveKeyInfo,
  selectGetMnemonic,
} from '../../../state/keyring';
import { contactsSelector, type ContactNetwork } from '../../../state/contacts';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { Amount } from '@penumbra-zone/protobuf/penumbra/core/num/v1/num_pb';
import { Value } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import {
  getDisplayDenomFromView,
  getAssetIdFromValueView,
  getDisplayDenomExponentFromValueView,
} from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { assetPatterns } from '@rotko/penumbra-types/assets';
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

/** input asset with balance */
interface InputAsset {
  balance: BalancesResponse;
  symbol: string;
  amount: string;
  assetId: Uint8Array | undefined;
  exponent: number;
}

/** output asset from assets list */
interface OutputAsset {
  response: AssetsResponse;
  symbol: string;
  assetId: Uint8Array | undefined;
  exponent: number;
}

export const SwapPage = () => {
  const activeNetwork = useStore(selectActiveNetwork);

  if (activeNetwork === 'zcash') return <ZcashCrosschainSwap />;
  if (activeNetwork === 'penumbra') return <PenumbraSwap />;

  return (
    <div className='flex flex-col items-center justify-center gap-3 py-12 text-center'>
      <div className='rounded-full bg-primary/10 p-4'>
        <span className='i-lucide-shuffle h-8 w-8 text-primary' />
      </div>
      <div>
        <h2 className='text-lg font-medium'>swap</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          swapping is not available for this network.
        </p>
      </div>
    </div>
  );
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
    if (!startMs) return;
    const tick = () => setElapsed(Math.round((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startMs]);

  return <div className='font-mono text-2xl tabular-nums text-primary'>{elapsed}s</div>;
}

const ZcashCrosschainSwap = () => {
  const navigate = useNavigate();
  const { address: zcashAddress } = useActiveAddress();
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { contacts } = useStore(contactsSelector);
  const [step, setStep] = useState<ZcashSwapStep>('input');
  const [direction, setDirection] = useState<'from_zec' | 'into_zec'>('from_zec');
  const [amountIn, setAmountIn] = useState('');
  const [selectedToken, setSelectedToken] = useState<NearToken | undefined>();
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [destinationAddress, setDestinationAddress] = useState('');
  const [showContacts, setShowContacts] = useState(false);
  const [quote, setQuote] = useState<SwapQuoteResponse | undefined>();
  const [swapStatus, setSwapStatus] = useState<SwapStatus | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [balanceZec, setBalanceZec] = useState<string | undefined>();
  const getMnemonic = useStore(selectGetMnemonic);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const { requestAuth, PasswordModal } = usePasswordGate();
  const [signRequestQr, setSignRequestQr] = useState<string | null>(null);
  const unsignedTxRef = useRef<any | null>(null);
  const [sendSteps, setSendSteps] = useState<
    Array<{ step: string; detail?: string; elapsedMs: number }>
  >([]);
  const buildStartRef = useRef<number>(0);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const ufvk =
    activeZcashWallet?.ufvk ??
    (activeZcashWallet?.orchardFvk?.startsWith('uview') ? activeZcashWallet.orchardFvk : undefined);

  const isFromZec = direction === 'from_zec';

  //zcash-send-progress
  useEffect(() => {
    if (step !== 'sending') return;

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
    if (!walletId) return;
    getBalanceInWorker('zcash', walletId)
      .then(b => {
        const zec = (Number(b) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
        setBalanceZec(zec);
      })
      .catch(() => {});
  }, [walletId]);

  // fetch supported tokens + resolve ZEC asset ID dynamically
  const [zecAssetId, setZecAssetId] = useState<string | undefined>();
  const { data: tokens = [], isLoading: tokensLoading } = useQuery({
    queryKey: ['near-tokens'],
    staleTime: 300_000,
    queryFn: async () => {
      const all = await getSupportedTokens();
      setZecAssetId(findZecAssetId(all));
      return filterSwappableTokens(all);
    },
  });

  // popular tokens first
  const sortedTokens = useMemo(() => {
    const popular = ['BTC', 'ETH', 'USDC', 'USDT', 'SOL', 'NEAR'];
    return [...tokens].sort((a, b) => {
      const ai = popular.indexOf(a.symbol);
      const bi = popular.indexOf(b.symbol);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [tokens]);

  // map selected token's blockchain to contact network for address book
  const destContactNetwork = useMemo(() => {
    if (!selectedToken) return undefined;
    return blockchainToContactNetwork(selectedToken.blockchain) as ContactNetwork | undefined;
  }, [selectedToken]);

  // get contacts for the destination network
  const destContacts = useMemo(() => {
    if (!destContactNetwork) return [];
    return contacts
      .filter(c => c.addresses.some(a => a.network === destContactNetwork))
      .flatMap(c =>
        c.addresses
          .filter(a => a.network === destContactNetwork)
          .map(a => ({ name: c.name, address: a.address })),
      );
  }, [contacts, destContactNetwork]);

  const handleFlipDirection = useCallback(() => {
    if (step !== 'input') return;
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

    if (!zecAssetId) {
      setError('ZEC asset metadata still loading');
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
      setError(err instanceof Error ? err.message : 'failed to get quote');
      setStep('error');
    }
  }, [selectedToken, amountIn, zcashAddress, zecAssetId, destinationAddress, isFromZec]);

  const handleConfirmSwap = useCallback(async () => {
    if (!quote || !selectedKeyInfo) return;

    setError(undefined);

    try {
      if (isFromZec && selectedKeyInfo.type === 'mnemonic') {
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
        const mnemonic = await getMnemonic(walletId);

        const result = await buildSendTxInWorker(
          'zcash',
          walletId,
          zidecarUrl,
          quote.quote.depositAddress,
          amountZat,
          '',
          0,
          true,
          mnemonic,
        );

        if (!('txid' in result)) {
          throw new Error('failed to broadcast deposit transaction');
        }

        setStep('polling');
        return;
      }

      // setStep('deposit');
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
      setError(err instanceof Error ? err.message : 'failed to send deposit');
      setStep('error');
    }
  }, [quote, selectedKeyInfo, amountIn, getMnemonic, zidecarUrl, isFromZec, requestAuth]);

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
    if ((step !== 'deposit' && step !== 'polling') || !quote) return;

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
  const handleCopyDeposit = useCallback(() => {
    if (!quote) return;
    void navigator.clipboard.writeText(quote.quote.depositAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [quote]);

  const handleReset = useCallback(() => {
    setStep('input');
    setQuote(undefined);
    setSwapStatus(null);
    setError(undefined);
    setAmountIn('');
  }, []);

  const canQuote = selectedToken && parseFloat(amountIn) > 0 && zcashAddress && destinationAddress;

  return (
    <div className='flex flex-col gap-3 p-4'>
      {PasswordModal}
      {/* header with back arrow */}
      <div className='flex items-center gap-3 -mx-4 -mt-4 border-b border-border/40 px-4 py-3'>
        <button
          onClick={() => navigate(-1)}
          className='text-muted-foreground transition-colors hover:text-foreground'
        >
          <span className='i-lucide-arrow-left h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium'>crosschain swap</h1>
      </div>

      {step === 'input' && (
        <>
          {/* FROM card */}
          <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
            <div className='flex items-center justify-between mb-2'>
              <span className='text-xs text-muted-foreground'>you send</span>
              {isFromZec && balanceZec && (
                <button
                  onClick={() => {
                    const max = Math.max(0, parseFloat(balanceZec) - 0.0001);
                    setAmountIn(max.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));
                  }}
                  className='text-xs text-muted-foreground hover:text-foreground'
                >
                  bal: {parseFloat(balanceZec).toFixed(4)}
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
                className='flex-1 bg-transparent text-xl font-medium text-foreground placeholder:text-muted-foreground focus:outline-none'
              />
              {isFromZec ? (
                <div className='shrink-0 rounded-md bg-muted px-3 py-1.5 text-sm font-medium'>
                  ZEC
                </div>
              ) : (
                <button
                  onClick={() => setTokenPickerOpen(!tokenPickerOpen)}
                  disabled={tokensLoading}
                  className='shrink-0 flex items-center gap-1 rounded-md bg-muted px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/80 disabled:opacity-50'
                >
                  {tokensLoading ? '...' : (selectedToken?.symbol ?? 'select')}
                  <span
                    className={cn(
                      'i-lucide-chevron-down h-3.5 w-3.5 transition-transform',
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
              className='rounded-full border border-border/40 bg-background p-1.5 shadow-sm transition-colors hover:bg-muted/50'
              title='flip direction'
            >
              <div className='flex flex-col items-center'>
                <span className='i-lucide-arrow-down h-4 w-4' />
              </div>
            </button>
          </div>

          {/* TO card */}
          <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
            <div className='flex items-center justify-between mb-2'>
              <span className='text-xs text-muted-foreground'>you receive</span>
            </div>
            <div className='flex items-center gap-2'>
              <div className='flex-1 text-xl font-medium text-muted-foreground/50'>--</div>
              {isFromZec ? (
                <button
                  onClick={() => setTokenPickerOpen(!tokenPickerOpen)}
                  disabled={tokensLoading}
                  className='shrink-0 flex items-center gap-1 rounded-md bg-muted px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/80 disabled:opacity-50'
                >
                  {tokensLoading ? '...' : (selectedToken?.symbol ?? 'select')}
                  <span
                    className={cn(
                      'i-lucide-chevron-down h-3.5 w-3.5 transition-transform',
                      tokenPickerOpen && 'rotate-180',
                    )}
                  />
                </button>
              ) : (
                <div className='shrink-0 rounded-md bg-muted px-3 py-1.5 text-sm font-medium'>
                  ZEC
                </div>
              )}
            </div>
            {selectedToken && (
              <div className='mt-1 text-xs text-muted-foreground'>
                on {selectedToken.blockchain}
              </div>
            )}
          </div>

          {/* token picker dropdown */}
          {tokenPickerOpen && (
            <div className='rounded-lg border border-border/40 bg-background max-h-48 overflow-y-auto -mt-2'>
              {sortedTokens.map(t => (
                <button
                  key={t.assetId}
                  onClick={() => {
                    setSelectedToken(t);
                    setTokenPickerOpen(false);
                    setDestinationAddress('');
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                    selectedToken?.assetId === t.assetId && 'bg-muted/30',
                  )}
                >
                  <span className='font-medium'>{t.symbol}</span>
                  <span className='text-xs text-muted-foreground'>{t.blockchain}</span>
                </button>
              ))}
              {sortedTokens.length === 0 && (
                <div className='px-3 py-2 text-sm text-muted-foreground'>no tokens available</div>
              )}
            </div>
          )}

          {/* destination address */}
          <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
            <div className='flex items-center justify-between mb-1'>
              <span className='text-xs text-muted-foreground'>
                {isFromZec
                  ? `${selectedToken?.blockchain ?? 'destination'} recipient`
                  : `your ${selectedToken?.blockchain ?? 'source'} address`}
              </span>
              {destContacts.length > 0 && (
                <button
                  onClick={() => setShowContacts(!showContacts)}
                  className={cn(
                    'p-0.5 transition-colors',
                    showContacts
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  title='address book'
                >
                  <span className='i-lucide-user h-3.5 w-3.5' />
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
              className='w-full bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none'
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
                    className='rounded-md bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground transition-colors'
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
              'w-full bg-primary py-3 text-sm font-medium text-primary-foreground',
              'transition-colors hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            get quote
          </button>

          <p className='text-center text-[10px] text-muted-foreground/60'>
            via NEAR 1Click — swap details shared with third-party API
          </p>
        </>
      )}

      {step === 'quoting' && (
        <div className='flex flex-col items-center gap-3 py-12'>
          <span className='i-lucide-refresh-cw h-6 w-6 animate-spin text-muted-foreground' />
          <p className='text-sm text-muted-foreground'>fetching quote...</p>
        </div>
      )}

      {step === 'review' && quote && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-zigner-gold/30 bg-card/50 p-3'>
            <p className='mb-2 text-xs font-medium text-zigner-gold'>confirm swap</p>

            <div className='flex flex-col gap-1.5 text-xs'>
              <div className='flex justify-between'>
                <span className='text-muted-foreground'>you send</span>
                <span>{amountIn} ZEC</span>
              </div>

              <div className='flex justify-between'>
                <span className='text-muted-foreground'>you receive</span>
                <span>
                  {quote.quote.amountOutFormatted} {isFromZec ? selectedToken?.symbol : 'ZEC'}
                </span>
              </div>

              <div className='flex justify-between gap-2'>
                <span className='shrink-0 text-muted-foreground'>recipient</span>
                <span className='break-all text-right font-mono'>{destinationAddress}</span>
              </div>

              <div className='flex justify-between gap-2'>
                <span className='shrink-0 text-muted-foreground'>deposit address</span>
                <span className='break-all text-right font-mono'>{quote.quote.depositAddress}</span>
              </div>
            </div>

            <div className='mt-3 flex gap-2'>
              <button
                onClick={() => void handleConfirmSwap()}
                className='flex-1 rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark transition-colors hover:bg-zigner-gold-light'
              >
                confirm & send
              </button>

              <button
                onClick={() => setStep('input')}
                className='flex-1 rounded-lg border border-border/40 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground'
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
            <p className='text-sm text-muted-foreground'>1. open zigner on your phone</p>
            <p className='text-sm text-muted-foreground'>2. scan this qr code</p>
            <p className='text-sm text-muted-foreground'>3. review and approve the transaction</p>
          </div>

          <button
            onClick={() => setStep('scan')}
            className='w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark transition-colors hover:bg-zigner-gold-light'
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
          <div className='w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center'>
            <div className='w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin' />
          </div>
          <h2 className='text-lg font-medium'>building transaction</h2>

          <LiveTimer startMs={buildStartRef.current} />

          {sendSteps.length > 0 ? (
            <div className='w-full max-w-sm flex flex-col gap-1'>
              {sendSteps.map((s, i) => {
                const isLast = i === sendSteps.length - 1;
                const prevMs = i > 0 ? sendSteps[i - 1]!.elapsedMs : 0;
                const stepDuration = ((s.elapsedMs - prevMs) / 1000).toFixed(1);

                return (
                  <div
                    key={i}
                    className={`flex items-start gap-2 text-xs ${
                      isLast ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <span className='font-mono w-12 text-right shrink-0'>
                      {(s.elapsedMs / 1000).toFixed(1)}s
                    </span>
                    <span>
                      {s.step}
                      {s.detail && <span className='text-muted-foreground ml-1'>({s.detail})</span>}
                      {!isLast && Number(stepDuration) >= 0.5 && (
                        <span className='text-muted-foreground ml-1'>+{stepDuration}s</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className='text-sm text-muted-foreground text-center'>preparing...</p>
          )}
        </div>
      )}

      {(step === 'deposit' || step === 'polling') && quote && (
        <div className='flex flex-col gap-3'>
          {/* quote summary */}
          <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
            <div className='flex justify-between text-sm'>
              <span className='text-muted-foreground'>send</span>
              <span className='font-medium'>
                {quote.quote.amountInFormatted} {isFromZec ? 'ZEC' : selectedToken?.symbol}
              </span>
            </div>
            <div className='flex justify-between text-sm mt-1'>
              <span className='text-muted-foreground'>receive</span>
              <span className='font-medium'>
                {quote.quote.amountOutFormatted} {isFromZec ? selectedToken?.symbol : 'ZEC'}
              </span>
            </div>
            {quote.quote.amountInUsd !== '0' && (
              <div className='flex justify-between text-xs text-muted-foreground mt-1'>
                <span>value</span>
                <span>${parseFloat(quote.quote.amountInUsd).toFixed(2)}</span>
              </div>
            )}
          </div>

          {/* status */}
          <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
            <div className='flex items-center gap-2'>
              {step === 'polling' ? (
                <span className='i-lucide-refresh-cw h-4 w-4 animate-spin text-primary' />
              ) : (
                <div className='h-2 w-2 rounded-full bg-yellow-500 animate-pulse' />
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

          <button
            onClick={handleReset}
            className='text-xs text-muted-foreground hover:text-foreground'
          >
            cancel
          </button>
        </div>
      )}

      {step === 'done' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-green-500/40 bg-green-500/10 p-3'>
            <p className='text-sm text-green-400'>swap complete</p>
            {quote && (
              <p className='text-xs text-muted-foreground mt-1'>
                {quote.quote.amountInFormatted} {isFromZec ? 'ZEC' : selectedToken?.symbol}
                {' → '}
                {quote.quote.amountOutFormatted} {isFromZec ? selectedToken?.symbol : 'ZEC'}
              </p>
            )}
          </div>
          <button
            onClick={handleReset}
            className='w-full rounded-lg bg-primary py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
          >
            swap again
          </button>
        </div>
      )}

      {step === 'error' && (
        <div className='flex flex-col gap-3'>
          <div className='rounded-lg border border-red-500/40 bg-red-500/10 p-3'>
            <p className='text-sm text-red-400'>swap failed</p>
            <p className='text-xs text-muted-foreground mt-1'>{error}</p>
          </div>
          <button
            onClick={handleReset}
            className='w-full rounded-lg bg-primary py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
          >
            try again
          </button>
        </div>
      )}
    </div>
  );
};

// ── Penumbra DEX Swap ──

const PenumbraSwap = () => {
  const navigate = useNavigate();
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [amountIn, setAmountIn] = useState('');
  const [assetInOpen, setAssetInOpen] = useState(false);
  const [assetOutOpen, setAssetOutOpen] = useState(false);
  const [selectedIn, setSelectedIn] = useState<InputAsset | undefined>();
  const [selectedOut, setSelectedOut] = useState<OutputAsset | undefined>();
  const [txStatus, setTxStatus] = useState<
    'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'
  >('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();

  const penumbraTx = usePenumbraTransaction();

  // fetch balances
  const {
    data: balances = [],
    isLoading: balancesLoading,
    refetch: refetchBalances,
  } = useQuery({
    queryKey: ['balances', penumbraAccount],
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(
          viewClient.balances({ accountFilter: { account: penumbraAccount } }),
        );
        return raw
          .filter(b => {
            const meta = getMetadataFromBalancesResponse.optional(b);
            if (!meta?.base || typeof meta.base !== 'string') return true;
            return !(
              assetPatterns.auctionNft.matches(meta.base) ||
              assetPatterns.lpNft.matches(meta.base) ||
              assetPatterns.proposalNft.matches(meta.base) ||
              assetPatterns.votingReceipt.matches(meta.base) ||
              assetPatterns.delegationToken.matches(meta.base) ||
              assetPatterns.unbondingToken.matches(meta.base)
            );
          })
          .sort((a, b) => {
            const aScore = getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n;
            const bScore = getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n;
            return Number(bScore - aScore);
          });
      } catch {
        return [];
      }
    },
  });

  const { data: allAssets = [], isLoading: assetsLoading } = useQuery({
    queryKey: ['assets'],
    staleTime: 300_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.assets({}));
        return raw
          .filter(resp => {
            const meta = resp.denomMetadata;
            if (!meta?.base || typeof meta.base !== 'string') return true;
            return !(
              assetPatterns.auctionNft.matches(meta.base) ||
              assetPatterns.lpNft.matches(meta.base) ||
              assetPatterns.proposalNft.matches(meta.base) ||
              assetPatterns.votingReceipt.matches(meta.base) ||
              assetPatterns.delegationToken.matches(meta.base) ||
              assetPatterns.unbondingToken.matches(meta.base)
            );
          })
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
      const symbol = b.balanceView
        ? getDisplayDenomFromView(b.balanceView) || 'Unknown'
        : 'Unknown';
      const amt = b.balanceView ? fromValueView(b.balanceView) : 0;
      const amount = typeof amt === 'string' ? amt : amt.toString();
      const assetId = b.balanceView ? getAssetIdFromValueView(b.balanceView)?.inner : undefined;
      const exponent = b.balanceView ? getDisplayDenomExponentFromValueView(b.balanceView) : 6;
      return { balance: b, symbol, amount, assetId, exponent };
    });
  }, [balances]);

  const outputAssets: OutputAsset[] = useMemo(() => {
    return allAssets.map(resp => {
      const meta = resp.denomMetadata;
      const symbol = meta?.symbol || meta?.display || meta?.base || 'Unknown';
      const assetId = meta?.penumbraAssetId?.inner;
      const exponent = meta?.denomUnits?.find(u => u.denom === meta?.display)?.exponent ?? 6;
      return { response: resp, symbol, assetId, exponent };
    });
  }, [allAssets]);

  useEffect(() => {
    if (!selectedIn && inputAssets.length > 0) {
      setSelectedIn(inputAssets[0]);
    }
  }, [inputAssets, selectedIn]);

  const {
    data: simulation,
    isLoading: simLoading,
    error: simError,
  } = useQuery({
    queryKey: ['simulate', selectedIn?.assetId, selectedOut?.assetId, amountIn],
    enabled: !!selectedIn && !!selectedOut && parseFloat(amountIn) > 0,
    staleTime: 10_000,
    queryFn: async () => {
      if (!selectedIn || !selectedOut || !amountIn || parseFloat(amountIn) <= 0) return null;

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
      if (!execution) return null;

      let totalOutput = 0n;
      for (const trace of execution.traces ?? []) {
        const outputValue = trace.value?.at(-1);
        if (outputValue?.amount) {
          totalOutput += outputValue.amount.lo ?? 0n;
        }
      }

      const outputAmount = Number(totalOutput) / 10 ** selectedOut.exponent;

      return {
        outputAmount: outputAmount.toFixed(6),
        priceImpact: result.unfilled ? 'partial fill' : undefined,
      };
    },
  });

  const handleMax = useCallback(() => {
    if (selectedIn) setAmountIn(selectedIn.amount);
  }, [selectedIn]);

  const handleFlip = useCallback(() => {
    if (selectedIn && selectedOut) {
      const newIn = inputAssets.find(
        a =>
          a.assetId &&
          selectedOut.assetId &&
          a.assetId.length === selectedOut.assetId.length &&
          a.assetId.every((v, i) => v === selectedOut.assetId![i]),
      );
      if (newIn) {
        const newOut = outputAssets.find(
          a =>
            a.assetId &&
            selectedIn.assetId &&
            a.assetId.length === selectedIn.assetId.length &&
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

  const canSubmit =
    selectedIn && selectedOut && parseFloat(amountIn) > 0 && simulation && txStatus === 'idle';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedIn || !selectedOut) return;

    setTxStatus('planning');
    setTxError(undefined);

    try {
      const multiplier = 10 ** selectedIn.exponent;
      const baseAmount = BigInt(Math.floor(parseFloat(amountIn) * multiplier));

      const { address: claimAddress } = await viewClient.addressByIndex({
        addressIndex: { account: penumbraAccount },
      });

      const planRequest = new TransactionPlannerRequest({
        swaps: [
          {
            targetAsset: { inner: selectedOut.assetId },
            value: new Value({
              amount: new Amount({ lo: baseAmount, hi: 0n }),
              assetId: { inner: selectedIn.assetId },
            }),
            claimAddress,
          },
        ],
        source: { account: penumbraAccount },
      });

      setTxStatus('signing');
      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);
      void refetchBalances();
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'swap failed');
    }
  }, [canSubmit, selectedIn, selectedOut, amountIn, penumbraTx, refetchBalances]);

  const handleReset = useCallback(() => {
    setTxStatus('idle');
    setTxHash(undefined);
    setTxError(undefined);
    setAmountIn('');
  }, []);

  return (
    <div className='flex flex-col gap-4 p-4'>
      <div className='flex items-center gap-3 -mx-4 -mt-4 border-b border-border/40 px-4 py-3 mb-1'>
        <button
          onClick={() => navigate(-1)}
          className='text-muted-foreground transition-colors hover:text-foreground'
        >
          <span className='i-lucide-arrow-left h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium'>swap</h1>
      </div>

      {/* input asset */}
      <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
        <div className='flex items-center justify-between mb-2'>
          <span className='text-xs text-muted-foreground'>you pay</span>
          {selectedIn && (
            <span className='text-xs text-muted-foreground'>balance: {selectedIn.amount}</span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <input
            type='text'
            value={amountIn}
            onChange={e => setAmountIn(e.target.value)}
            placeholder='0.00'
            disabled={txStatus !== 'idle'}
            className='flex-1 bg-transparent text-lg font-medium text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50'
          />
          <button
            onClick={handleMax}
            disabled={txStatus !== 'idle' || !selectedIn}
            className='text-xs text-zigner-gold hover:text-zigner-gold-light disabled:opacity-50'
          >
            max
          </button>
        </div>
        <div className='mt-2 relative'>
          <button
            onClick={() => setAssetInOpen(!assetInOpen)}
            disabled={txStatus !== 'idle' || balancesLoading}
            className='flex items-center gap-2 rounded-md bg-background/50 px-3 py-1.5 text-sm transition-colors hover:bg-background disabled:opacity-50'
          >
            {balancesLoading ? (
              <span className='text-muted-foreground'>loading...</span>
            ) : selectedIn ? (
              <span className='font-medium'>{selectedIn.symbol}</span>
            ) : (
              <span className='text-muted-foreground'>select</span>
            )}
            <span
              className={cn(
                'i-lucide-chevron-down h-4 w-4 transition-transform',
                assetInOpen && 'rotate-180',
              )}
            />
          </button>

          {assetInOpen && (
            <div className='absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border/40 bg-background shadow-lg'>
              {inputAssets.map((item, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedIn(item);
                    setAssetInOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                    selectedIn === item && 'bg-muted/30',
                  )}
                >
                  <span>{item.symbol}</span>
                  <span className='text-muted-foreground'>{item.amount}</span>
                </button>
              ))}
              {inputAssets.length === 0 && (
                <div className='px-3 py-2 text-sm text-muted-foreground'>no assets</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* swap direction */}
      <div className='flex justify-center -my-2'>
        <button
          onClick={handleFlip}
          disabled={txStatus !== 'idle' || !selectedIn || !selectedOut}
          className='rounded-full border border-border/40 bg-background p-2 shadow-sm transition-colors hover:bg-muted/50 disabled:opacity-50'
        >
          <span className='i-lucide-arrow-down h-4 w-4' />
        </button>
      </div>

      {/* output asset */}
      <div className='rounded-lg border border-border/40 bg-muted/20 p-3'>
        <div className='flex items-center justify-between mb-2'>
          <span className='text-xs text-muted-foreground'>you receive</span>
          {simLoading && (
            <span className='flex items-center gap-1 text-xs text-muted-foreground'>
              <span className='i-lucide-refresh-cw h-3 w-3 animate-spin' />
              simulating...
            </span>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <div className='flex-1 text-lg font-medium text-foreground'>
            {simulation?.outputAmount ?? '0.00'}
          </div>
        </div>
        <div className='mt-2 relative'>
          <button
            onClick={() => setAssetOutOpen(!assetOutOpen)}
            disabled={txStatus !== 'idle' || assetsLoading}
            className='flex items-center gap-2 rounded-md bg-background/50 px-3 py-1.5 text-sm transition-colors hover:bg-background disabled:opacity-50'
          >
            {assetsLoading ? (
              <span className='text-muted-foreground'>loading...</span>
            ) : selectedOut ? (
              <span className='font-medium'>{selectedOut.symbol}</span>
            ) : (
              <span className='text-muted-foreground'>select</span>
            )}
            <span
              className={cn(
                'i-lucide-chevron-down h-4 w-4 transition-transform',
                assetOutOpen && 'rotate-180',
              )}
            />
          </button>

          {assetOutOpen && (
            <div className='absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border/40 bg-background shadow-lg'>
              {outputAssets
                .filter(a => {
                  if (!selectedIn?.assetId || !a.assetId) return true;
                  if (selectedIn.assetId.length !== a.assetId.length) return true;
                  return !selectedIn.assetId.every((v, i) => v === a.assetId![i]);
                })
                .map((item, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedOut(item);
                      setAssetOutOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                      selectedOut?.symbol === item.symbol && 'bg-muted/30',
                    )}
                  >
                    <span>{item.symbol}</span>
                  </button>
                ))}
              {outputAssets.length === 0 && (
                <div className='px-3 py-2 text-sm text-muted-foreground'>no assets</div>
              )}
            </div>
          )}
        </div>
      </div>

      {simulation?.priceImpact && (
        <div className='rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-2'>
          <p className='text-xs text-yellow-400'>{simulation.priceImpact}</p>
        </div>
      )}

      {simError && (
        <p className='text-xs text-red-400'>
          {(simError as Error).message || 'failed to simulate swap'}
        </p>
      )}

      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/40 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>swap submitted!</p>
          <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>{txHash}</p>
          <p className='text-xs text-muted-foreground mt-2'>
            note: swap outputs will be available after the claim transaction is processed.
          </p>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/40 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>swap failed</p>
          <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
        </div>
      )}

      <button
        onClick={() => {
          if (txStatus === 'success' || txStatus === 'error') handleReset();
          else void handleSubmit();
        }}
        disabled={
          (txStatus === 'idle' && !canSubmit) ||
          txStatus === 'planning' ||
          txStatus === 'signing' ||
          txStatus === 'broadcasting'
        }
        className={cn(
          'mt-2 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
          'transition-colors hover:bg-zigner-gold-light',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        {txStatus === 'planning' && 'building swap...'}
        {txStatus === 'signing' && 'signing...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && (simLoading ? 'simulating...' : 'swap')}
        {txStatus === 'success' && 'swap again'}
        {txStatus === 'error' && 'retry'}
      </button>

      <p className='text-center text-xs text-muted-foreground'>private swap using penumbra dex</p>
    </div>
  );
};
