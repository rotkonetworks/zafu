/**
 * penumbra native send + ibc-withdraw tab shell
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../../../state';
import { selectPenumbraAccount } from '../../../state/keyring';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { selectPenumbraSend } from '../../../state/penumbra-send';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { AssetIcon } from '@repo/ui/components/ui/asset-icon';
import { symbolFromMetadata } from '../../../utils/asset-display';
import {
  isPositionBalance,
  positionLabel,
  selectPickerBuckets,
} from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import { AssetBucketToggle, type AssetBucket } from '../../../components/asset-bucket-toggle';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { RecipientPicker } from '../../../components/recipient-picker';
import { QrScanner } from '../../../shared/components/qr-scanner';

import { EMPTY_BALANCES } from './shared';
import { PenumbraIbcSend } from './ibc-send';

type PenumbraMode = 'send' | 'ibc';

/** Combined Penumbra send with tabs */
export function PenumbraSend({
  onSuccess,
  prefillAsset,
}: {
  onSuccess?: () => void;
  prefillAsset?: string;
}) {
  const [mode, setMode] = useState<PenumbraMode>('send');

  return (
    <div className='flex flex-col gap-4'>
      {/* mode tabs */}
      <div className='flex bg-elev-2 p-1'>
        <button
          onClick={() => setMode('send')}
          className={cn(
            'flex-1 py-2 text-sm font-medium transition-colors',
            mode === 'send' ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high',
          )}
        >
          send
        </button>
        <button
          onClick={() => setMode('ibc')}
          className={cn(
            'flex-1 py-2 text-sm font-medium transition-colors',
            mode === 'ibc' ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high',
          )}
        >
          ibc withdraw
        </button>
      </div>

      {mode === 'send' ? (
        <PenumbraNativeSend onSuccess={onSuccess} prefillAsset={prefillAsset} />
      ) : (
        <PenumbraIbcSend onSuccess={onSuccess} />
      )}
    </div>
  );
}

/** Penumbra native send form (penumbra -> penumbra) */
function PenumbraNativeSend({
  onSuccess,
  prefillAsset,
}: {
  onSuccess?: () => void;
  /** Base denom of the asset the caller (row-level Send action) wants preselected. */
  prefillAsset?: string;
}) {
  const sendState = useStore(selectPenumbraSend);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [txStatus, setTxStatus] = useState<
    'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'
  >('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const [assetOpen, setAssetOpen] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);

  const penumbraTx = usePenumbraTransaction();

  // fetch balances. The ['balances', account] cache holds the RAW list (the
  // home screen preloads it); `select` buckets it per observer, so the picker
  // filter applies no matter who populated the cache.
  const { data: buckets, isLoading: balancesLoading } = useQuery({
    ...balancesQueryOptions(penumbraAccount),
    staleTime: 30_000,
    select: selectPickerBuckets,
  });
  const balances = buckets?.assets ?? EMPTY_BALANCES;
  const positions = buckets?.positions ?? EMPTY_BALANCES;
  const [bucket, setBucket] = useState<AssetBucket>('assets');

  // the picker always reopens on the fungible list
  useEffect(() => {
    if (!assetOpen) {
      setBucket('assets');
    }
  }, [assetOpen]);

  // local state for selected asset (not in zustand due to immer/protobuf incompatibility)
  const [selectedAsset, setSelectedAsset] = useState<BalancesResponse | undefined>();

  // auto-select first balance if none selected. If the caller pre-filled an
  // asset (row-level "Send USDC" action on home) prefer the balance whose
  // metadata.base matches; fall back to the top-priority balance so the form
  // is never empty when the user has funds.
  useEffect(() => {
    if (selectedAsset || balances.length === 0) {
      return;
    }
    const match = prefillAsset
      ? balances.find(b => getMetadataFromBalancesResponse.optional(b)?.base === prefillAsset)
      : undefined;
    setSelectedAsset(match ?? balances[0]);
  }, [balances, selectedAsset, prefillAsset]);

  // recent addresses
  const { recordUsage } = useStore(recentAddressesSelector);

  const addressValid = useMemo(
    () => !sendState.recipient || sendState.recipient.startsWith('penumbra1'),
    [sendState.recipient],
  );

  // get display info for selected asset
  const selectedSymbol = useMemo(() => {
    if (!selectedAsset?.balanceView) {
      return 'asset';
    }
    const meta = getMetadataFromBalancesResponse.optional(selectedAsset);
    return positionLabel(meta) ?? symbolFromMetadata(meta);
  }, [selectedAsset]);

  const selectedBalance = useMemo(() => {
    if (!selectedAsset?.balanceView) {
      return '0';
    }
    const val = fromValueView(selectedAsset.balanceView);
    return typeof val === 'string' ? val : val.toString();
  }, [selectedAsset]);

  const handleMax = useCallback(() => {
    // Set the visible amount to the full balance and flip maxMode on.
    // The submit path in penumbra-send state's buildPlanRequest then
    // takes the spend-all branch (dry-run autoFee, reissue manualFee)
    // so the output lands at balance - fee for same-asset fees, or at
    // balance for cross-asset (fee comes out of separate UM balance).
    // No change note is created either way - no dust left behind.
    // sendState.setAmount clears maxMode on any subsequent keystroke.
    sendState.setAmount(selectedBalance);
    sendState.setMaxMode(true);
  }, [selectedBalance, sendState]);

  const canSubmit =
    addressValid &&
    sendState.recipient &&
    selectedAsset &&
    sendState.amount &&
    parseFloat(sendState.amount) > 0 &&
    txStatus === 'idle';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedAsset) {
      return;
    }

    setTxStatus('planning');
    setTxError(undefined);

    try {
      const planRequest = await sendState.buildPlanRequest(selectedAsset);
      setTxStatus('signing');

      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);

      // record address usage
      void recordUsage(sendState.recipient, 'penumbra');

      // reset form after success
      sendState.reset();
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'transaction failed');
    }
  }, [canSubmit, selectedAsset, sendState, penumbraTx, recordUsage]);

  const handleReset = useCallback(() => {
    setTxStatus('idle');
    setTxHash(undefined);
    setTxError(undefined);
  }, []);

  return (
    <div className='flex flex-col gap-4'>
      {/* asset selector */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>asset</label>
        <div className='relative'>
          <button
            onClick={() => setAssetOpen(!assetOpen)}
            disabled={txStatus !== 'idle' || balancesLoading}
            className='flex w-full items-center justify-between border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50 disabled:opacity-50'
          >
            {balancesLoading ? (
              <span className='text-fg-muted'>loading...</span>
            ) : selectedAsset ? (
              <span className='flex items-center gap-1.5'>
                <AssetIcon
                  metadata={getMetadataFromBalancesResponse.optional(selectedAsset)}
                  size='xs'
                />
                {selectedSymbol}
              </span>
            ) : (
              <span className='text-fg-muted'>select asset</span>
            )}
            <span
              className={cn(
                'i-ph-caret-down h-4 w-4 transition-transform',
                assetOpen && 'rotate-180',
              )}
            />
          </button>

          {assetOpen && (
            <div className='absolute top-full left-0 right-0 z-50 mt-1 border border-border-soft bg-canvas shadow-lg'>
              <div className='border-b border-border-soft p-1.5'>
                <AssetBucketToggle
                  bucket={bucket}
                  onChange={setBucket}
                  positionCount={positions.length}
                />
              </div>
              <div className='max-h-48 overflow-y-auto'>
                {(bucket === 'assets' ? balances : positions).map((balance, i) => {
                  if (!balance.balanceView) {
                    return null;
                  }
                  const meta = getMetadataFromBalancesResponse.optional(balance);
                  const isPosition = bucket === 'positions';
                  const symbol = isPosition
                    ? (positionLabel(meta) ?? symbolFromMetadata(meta))
                    : symbolFromMetadata(meta);
                  const amt = fromValueView(balance.balanceView);
                  const amountStr = typeof amt === 'string' ? amt : amt.toString();
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        const wasPosition = !!selectedAsset && isPositionBalance(selectedAsset);
                        setSelectedAsset(balance);
                        if (isPosition) {
                          // a position NFT is indivisible - send the whole thing
                          sendState.setAmount(amountStr);
                        } else if (wasPosition) {
                          // don't carry the position's "1" over to a fungible asset
                          sendState.setAmount('');
                        }
                        setAssetOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-elev-1',
                        selectedAsset === balance && 'bg-elev-2',
                      )}
                    >
                      <span className='flex min-w-0 items-center gap-1.5'>
                        <AssetIcon metadata={meta} size='xs' />
                        <span className='truncate'>{symbol}</span>
                      </span>
                      <span className='text-fg-muted'>{amountStr}</span>
                    </button>
                  );
                })}
                {bucket === 'assets' && balances.length === 0 && (
                  <div className='px-3 py-2 text-sm text-fg-muted'>no assets</div>
                )}
                {bucket === 'positions' && positions.length === 0 && (
                  <div className='px-3 py-2 text-sm text-fg-muted'>no open positions</div>
                )}
              </div>
            </div>
          )}
        </div>
        {selectedAsset && (
          <p className='mt-1 text-xs text-fg-muted'>
            balance: {selectedBalance} {selectedSymbol}
          </p>
        )}
      </div>

      {/* recipient address */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>recipient (penumbra1...)</label>
        <div className='flex gap-1'>
          <input
            type='text'
            value={sendState.recipient}
            onChange={e => sendState.setRecipient(e.target.value)}
            placeholder='penumbra1...'
            disabled={txStatus !== 'idle'}
            className={cn(
              'flex-1 border bg-input px-3 py-2.5 text-sm text-fg',
              'placeholder:text-fg-muted transition-colors duration-100',
              'focus:border-penumbra-purple focus:outline-none disabled:opacity-50',
              sendState.recipient && !addressValid ? 'border-red-400' : 'border-border-soft',
            )}
          />
          <button
            type='button'
            onClick={() => setShowQrScanner(true)}
            disabled={txStatus !== 'idle'}
            className='shrink-0 flex h-[42px] w-[42px] items-center justify-center border border-border-soft bg-input text-fg-muted hover:text-fg-high transition-colors disabled:opacity-50'
            title='scan QR code'
          >
            <span className='i-ph-scan h-4 w-4' />
          </button>
        </div>
        {showQrScanner && (
          <QrScanner
            onScan={data => {
              sendState.setRecipient(data);
              setShowQrScanner(false);
            }}
            onClose={() => setShowQrScanner(false)}
            title='scan address'
            description='scan a penumbra address QR code'
            inline
          />
        )}
        {sendState.recipient && !addressValid && (
          <p className='mt-1 text-xs text-red-400'>invalid penumbra address</p>
        )}
        <RecipientPicker
          network='penumbra'
          onSelect={sendState.setRecipient}
          show={!sendState.recipient}
        />
      </div>

      {/* amount */}
      <div>
        <div className='flex items-center justify-between mb-1'>
          <label className='text-xs text-fg-muted'>amount</label>
          <button
            onClick={handleMax}
            disabled={txStatus !== 'idle' || !selectedAsset}
            className='text-xs text-zigner-gold hover:text-zigner-gold-light disabled:opacity-50'
          >
            max
          </button>
        </div>
        <input
          type='text'
          value={sendState.amount}
          onChange={e => sendState.setAmount(e.target.value)}
          placeholder='0.00'
          disabled={txStatus !== 'idle'}
          // When a row-level Send picked the asset for us, the user's only
          // remaining decision on the "amount" pane is how much - land them
          // in the amount field. Without a prefill we leave focus to the
          // default (recipient field is the first thing they need to fill).
          autoFocus={!!prefillAsset}
          className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none disabled:opacity-50'
        />
      </div>

      {/* memo */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>memo (optional)</label>
        <input
          type='text'
          value={sendState.memo}
          onChange={e => sendState.setMemo(e.target.value)}
          placeholder='optional message'
          disabled={txStatus !== 'idle'}
          className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none disabled:opacity-50'
        />
      </div>

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='border border-green-500/40 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-fg-muted mt-1 font-mono break-all'>{txHash}</p>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='border border-red-500/40 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-fg-muted mt-1'>{txError}</p>
        </div>
      )}

      {/* submit */}
      <Button
        variant='primary'
        onClick={() => {
          if (txStatus === 'success') {
            onSuccess ? onSuccess() : handleReset();
          } else if (txStatus === 'error') {
            handleReset();
          } else {
            void handleSubmit();
          }
        }}
        disabled={
          (txStatus === 'idle' && !canSubmit) ||
          txStatus === 'planning' ||
          txStatus === 'signing' ||
          txStatus === 'broadcasting'
        }
        className='mt-2 w-full'
      >
        {txStatus === 'planning' && 'building plan...'}
        {txStatus === 'signing' && 'signing...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && 'send'}
        {txStatus === 'success' && (onSuccess ? 'close' : 'send another')}
        {txStatus === 'error' && 'retry'}
      </Button>

      {sendState.error && txStatus === 'idle' && (
        <p className='text-center text-xs text-red-400'>{sendState.error}</p>
      )}

      <p className='text-center text-xs text-fg-muted'>private transfer within penumbra</p>
    </div>
  );
}
