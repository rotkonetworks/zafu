/**
 * multi-network send screen
 * penumbra supports IBC withdrawals to cosmos chains
 * cosmos chains use skip go api for routing
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeftIcon, ChevronDownIcon, UpdateIcon, PersonIcon, Cross2Icon } from '@radix-ui/react-icons';
import { PopupPath } from '../paths';
import { useQuery } from '@tanstack/react-query';
import { ZcashSend } from './zcash-send';
import { useStore } from '../../../state';
import { activeNetworkSelector } from '../../../state/active-network';
import { recentAddressesSelector, type AddressNetwork } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { selectIbcWithdraw } from '../../../state/ibc-withdraw';
import { selectPenumbraSend } from '../../../state/penumbra-send';
import { useIbcChains, isValidIbcAddress, type IbcChain } from '../../../hooks/ibc-chains';
import { viewClient } from '../../../clients';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomFromView } from '@penumbra-zone/getters/value-view';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import { useSkipRoute, useSkipChains } from '../../../hooks/skip-route';
import { useCosmosSend, useCosmosIbcTransfer } from '../../../hooks/cosmos-signer';
import { useCosmosAssets, type CosmosAsset } from '../../../hooks/cosmos-balance';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { COSMOS_CHAINS, type CosmosChainId, isValidCosmosAddress, getChainFromAddress } from '@repo/wallet/networks/cosmos/chains';
import { cn } from '@repo/ui/lib/utils';

/** IBC chain selector dropdown */
function ChainSelector({
  chains,
  selected,
  onSelect,
}: {
  chains: IbcChain[];
  selected: IbcChain | undefined;
  onSelect: (chain: IbcChain) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center justify-between rounded-lg border border-border bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        {selected ? (
          <span>{selected.displayName}</span>
        ) : (
          <span className='text-muted-foreground'>select chain</span>
        )}
        <ChevronDownIcon className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-10 mt-1 rounded-lg border border-border bg-background shadow-lg overflow-hidden'>
          {chains.map(chain => (
            <button
              key={chain.chainId}
              onClick={() => {
                onSelect(chain);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                selected?.chainId === chain.chainId && 'bg-muted/30'
              )}
            >
              {chain.images[0]?.png && (
                <img src={chain.images[0].png} alt='' className='h-5 w-5 rounded-full' />
              )}
              <span>{chain.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** cosmos asset selector dropdown */
function AssetSelector({
  assets,
  selected,
  onSelect,
  loading,
}: {
  assets: CosmosAsset[];
  selected: CosmosAsset | undefined;
  onSelect: (asset: CosmosAsset) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (loading) {
    return <div className='h-10 rounded-lg bg-muted/30 animate-pulse' />;
  }

  if (assets.length === 0) {
    return (
      <div className='rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-muted-foreground'>
        no assets
      </div>
    );
  }

  return (
    <div className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center justify-between rounded-lg border border-border bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        {selected ? (
          <div className='flex items-center gap-2'>
            <span className='font-medium'>{selected.symbol}</span>
            <span className='text-muted-foreground'>{selected.formatted}</span>
          </div>
        ) : (
          <span className='text-muted-foreground'>select asset</span>
        )}
        <ChevronDownIcon className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg'>
          {assets.map(asset => (
            <button
              key={asset.denom}
              onClick={() => {
                onSelect(asset);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                selected?.denom === asset.denom && 'bg-muted/30'
              )}
            >
              <span className='font-medium'>{asset.symbol}</span>
              <span className='text-muted-foreground'>{asset.formatted}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** cosmos chain selector for skip routing */
function CosmosChainSelector({
  chains,
  selected,
  onSelect,
  currentChainId,
}: {
  chains: Array<{ chainId: string; chainName: string; bech32Prefix?: string; logoUri?: string }>;
  selected: string | undefined;
  onSelect: (chainId: string) => void;
  currentChainId: string;
}) {
  const [open, setOpen] = useState(false);
  const filteredChains = chains.filter(c => c.chainId !== currentChainId);

  return (
    <div className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center justify-between rounded-lg border border-border bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        {selected ? (
          <span>{chains.find(c => c.chainId === selected)?.chainName ?? selected}</span>
        ) : (
          <span className='text-muted-foreground'>select destination</span>
        )}
        <ChevronDownIcon className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg'>
          {filteredChains.map(chain => (
            <button
              key={chain.chainId}
              onClick={() => {
                onSelect(chain.chainId);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                selected === chain.chainId && 'bg-muted/30'
              )}
            >
              {chain.logoUri && (
                <img src={chain.logoUri} alt='' className='h-5 w-5 rounded-full' />
              )}
              <span>{chain.chainName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** contact save suggestion prompt */
function SaveContactPrompt({
  onSave,
  onDismiss,
}: {
  address: string;
  network: AddressNetwork;
  onSave: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className='rounded-lg border border-zigner-gold/30 bg-zigner-gold/10 p-3'>
      <div className='flex items-start justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <PersonIcon className='h-4 w-4 text-zigner-gold' />
          <div>
            <p className='text-sm text-foreground'>save to contacts?</p>
            <p className='text-xs text-muted-foreground'>
              you've sent to this address before
            </p>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className='text-muted-foreground hover:text-foreground transition-colors'
        >
          <Cross2Icon className='h-4 w-4' />
        </button>
      </div>
      <div className='mt-2 flex gap-2'>
        <button
          onClick={onSave}
          className='flex-1 rounded bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-dark transition-colors hover:bg-zigner-gold-light'
        >
          save contact
        </button>
        <button
          onClick={onDismiss}
          className='flex-1 rounded bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
        >
          not now
        </button>
      </div>
    </div>
  );
}

/** cosmos send form with skip routing */
function CosmosSend({ sourceChainId }: { sourceChainId: CosmosChainId }) {
  const sourceChain = COSMOS_CHAINS[sourceChainId];
  const [destChainId, setDestChainId] = useState<string | undefined>();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<CosmosAsset | undefined>();
  const [accountIndex, setAccountIndex] = useState(0);
  const [txStatus, setTxStatus] = useState<'idle' | 'signing' | 'broadcasting' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [contactName, setContactName] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave, dismissSuggestion, getRecent } = useStore(recentAddressesSelector);
  const { addContact, addAddress, findByAddress } = useStore(contactsSelector);

  // get recent addresses for cosmos network
  const recentAddresses = useMemo(() => getRecent('cosmos', 3), [getRecent]);

  const { data: skipChains = [], isLoading: chainsLoading } = useSkipChains();

  // assets hook - uses accountIndex
  const { data: assetsData, isLoading: assetsLoading, refetch: refetchAssets } = useCosmosAssets(sourceChainId, accountIndex);

  // auto-select native asset when data loads
  useMemo(() => {
    if (assetsData?.nativeAsset && !selectedAsset) {
      setSelectedAsset(assetsData.nativeAsset);
    }
  }, [assetsData, selectedAsset]);

  // signing hooks
  const cosmosSend = useCosmosSend();
  const cosmosIbcTransfer = useCosmosIbcTransfer();

  // set max amount for selected asset
  const handleSetMax = useCallback(() => {
    if (selectedAsset) {
      const maxAmount = Number(selectedAsset.amount) / Math.pow(10, selectedAsset.decimals);
      setAmount(maxAmount.toString());
    }
  }, [selectedAsset]);

  // convert amount to base units
  const amountInBase = useMemo(() => {
    if (!amount || isNaN(parseFloat(amount)) || !selectedAsset) return '0';
    return String(Math.floor(parseFloat(amount) * Math.pow(10, selectedAsset.decimals)));
  }, [amount, selectedAsset]);

  // find route via skip
  const {
    data: route,
    isLoading: routeLoading,
    error: routeError,
  } = useSkipRoute({
    sourceChainId: sourceChain.chainId,
    sourceAssetDenom: selectedAsset?.denom ?? sourceChain.denom,
    destChainId: destChainId ?? '',
    destAssetDenom: destChainId
      ? skipChains.find(c => c.chainId === destChainId)?.bech32Prefix
        ? `u${skipChains.find(c => c.chainId === destChainId)?.bech32Prefix?.replace('1', '')}`
        : selectedAsset?.denom ?? sourceChain.denom
      : selectedAsset?.denom ?? sourceChain.denom,
    amount: amountInBase,
    enabled: !!destChainId && parseFloat(amount) > 0 && !!selectedAsset,
  });

  // auto-detect destination chain from address
  const detectedChain = useMemo(() => {
    if (!recipient) return undefined;
    return getChainFromAddress(recipient);
  }, [recipient]);

  // validate recipient
  const recipientValid = useMemo(() => {
    if (!recipient) return false;
    if (destChainId) {
      const destPrefix = skipChains.find(c => c.chainId === destChainId)?.bech32Prefix;
      if (destPrefix) return recipient.startsWith(`${destPrefix}1`);
    }
    return isValidCosmosAddress(recipient);
  }, [recipient, destChainId, skipChains]);

const canSubmit = recipient && recipientValid && parseFloat(amount) > 0 && selectedAsset && txStatus === 'idle';
  const isSameChain = !destChainId || destChainId === sourceChain.chainId;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedAsset) return;

    setTxStatus('signing');
    setTxError(undefined);

    try {
      let result;

      if (isSameChain) {
        // same chain send
        result = await cosmosSend.mutateAsync({
          chainId: sourceChainId,
          toAddress: recipient,
          amount,
          denom: selectedAsset.denom,
          accountIndex,
        });
      } else {
        // need to find IBC channel for destination
        // for now, try to find channel from route
        const channel = route?.operations.find(op => op.transfer)?.transfer?.channel;
        if (!channel) {
          throw new Error('no ibc route found');
        }

        result = await cosmosIbcTransfer.mutateAsync({
          sourceChainId,
          destChainId: destChainId!,
          sourceChannel: channel,
          toAddress: recipient,
          amount,
          denom: selectedAsset.denom,
          accountIndex,
        });
      }

      setTxStatus('success');
      setTxHash(result.txHash);
      // refetch assets after tx
      void refetchAssets();
      // record address usage for contact suggestions
      void recordUsage(recipient, 'cosmos', sourceChainId);
      // check if we should prompt to save as contact
      if (shouldSuggestSave(recipient)) {
        setShowSavePrompt(true);
      }
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'transaction failed');
    }
  }, [canSubmit, isSameChain, sourceChainId, destChainId, recipient, amount, selectedAsset, accountIndex, route, cosmosSend, cosmosIbcTransfer, refetchAssets, recordUsage, shouldSuggestSave]);

  return (
    <div className='flex flex-col gap-4'>
      {/* account selector */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>account</label>
        <div className='flex items-center gap-2'>
          <select
            value={accountIndex}
            onChange={e => setAccountIndex(parseInt(e.target.value, 10))}
            className='flex-1 rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground transition-colors focus:border-zigner-gold focus:outline-none'
          >
            {[0, 1, 2, 3, 4].map(idx => (
              <option key={idx} value={idx}>
                account #{idx}
              </option>
            ))}
          </select>
          {assetsData?.address && (
            <span className='text-xs text-muted-foreground font-mono'>
              {assetsData.address.slice(0, 10)}...{assetsData.address.slice(-4)}
            </span>
          )}
        </div>
      </div>

      {/* destination chain */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>destination chain</label>
        {chainsLoading ? (
          <div className='h-10 rounded-lg bg-muted/30 animate-pulse' />
        ) : (
          <CosmosChainSelector
            chains={skipChains}
            selected={destChainId}
            onSelect={setDestChainId}
            currentChainId={sourceChain.chainId}
          />
        )}
      </div>

      {/* recipient */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>recipient</label>
        <input
          type='text'
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          placeholder='cosmos address'
          className={cn(
            'w-full rounded-lg border bg-input px-3 py-2.5 text-sm text-foreground',
            'placeholder:text-muted-foreground transition-colors duration-100',
            'focus:border-zigner-gold focus:outline-none',
            recipient && !recipientValid ? 'border-red-500' : 'border-border'
          )}
        />
        {recipient && !recipientValid && (
          <p className='mt-1 text-xs text-red-500'>invalid cosmos address</p>
        )}
        {detectedChain && (
          <p className='mt-1 text-xs text-muted-foreground'>
            detected: {detectedChain.name}
          </p>
        )}
        {/* recent addresses */}
        {!recipient && recentAddresses.length > 0 && (
          <div className='mt-2'>
            <p className='text-xs text-muted-foreground mb-1'>recent:</p>
            <div className='flex flex-wrap gap-1'>
              {recentAddresses.map(r => {
                const result = findByAddress(r.address);
                return (
                  <button
                    key={r.address}
                    onClick={() => setRecipient(r.address)}
                    className='rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
                  >
                    {result ? result.contact.name : `${r.address.slice(0, 8)}...${r.address.slice(-4)}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* asset selector */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>asset</label>
        <AssetSelector
          assets={assetsData?.assets ?? []}
          selected={selectedAsset}
          onSelect={setSelectedAsset}
          loading={assetsLoading}
        />
      </div>

      {/* amount */}
      <div>
        <div className='mb-1 flex items-center justify-between'>
          <label className='text-xs text-muted-foreground'>
            amount {selectedAsset ? `(${selectedAsset.symbol})` : ''}
          </label>
          {selectedAsset && (
            <span className='text-xs text-muted-foreground'>
              balance: {selectedAsset.formatted}
            </span>
          )}
        </div>
        <div className='relative'>
          <input
            type='text'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder='0.00'
            className='w-full rounded-lg border border-border bg-input px-3 py-2.5 pr-14 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none'
          />
          {selectedAsset && Number(selectedAsset.amount) > 0 && (
            <button
              type='button'
              onClick={handleSetMax}
              className='absolute right-2 top-1/2 -translate-y-1/2 rounded bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
            >
              max
            </button>
          )}
        </div>
      </div>

      {/* route info */}
      {routeLoading && (
        <div className='flex items-center gap-2 text-xs text-muted-foreground'>
          <UpdateIcon className='h-3 w-3 animate-spin' />
          finding route...
        </div>
      )}
      {route && (
        <div className='rounded-lg border border-border/50 bg-muted/20 p-3'>
          <div className='flex items-center justify-between text-xs'>
            <span className='text-muted-foreground'>receive</span>
            <span className='font-mono'>
              {(parseFloat(route.amountOut) / Math.pow(10, 6)).toFixed(6)}
            </span>
          </div>
          {route.doesSwap && route.swapVenue && (
            <div className='mt-1 flex items-center justify-between text-xs'>
              <span className='text-muted-foreground'>via</span>
              <span>{route.swapVenue.name}</span>
            </div>
          )}
          {route.txsRequired > 1 && (
            <div className='mt-1 flex items-center justify-between text-xs'>
              <span className='text-muted-foreground'>transactions</span>
              <span>{route.txsRequired}</span>
            </div>
          )}
        </div>
      )}
      {routeError && (
        <p className='text-xs text-red-500'>{(routeError as Error).message}</p>
      )}

{/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>
            {txHash}
          </p>
        </div>
      )}

      {/* save contact prompt */}
      {showSavePrompt && recipient && !findByAddress(recipient) && (
        <SaveContactPrompt
          address={recipient}
          network='cosmos'
          onSave={() => {
            setShowSavePrompt(false);
            setShowContactModal(true);
          }}
          onDismiss={() => {
            void dismissSuggestion(recipient);
            setShowSavePrompt(false);
          }}
        />
      )}

      {/* contact name modal */}
      {showContactModal && (
        <div className='rounded-lg border border-border bg-background p-3'>
          <p className='text-sm font-medium mb-2'>name this contact</p>
          <input
            type='text'
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            placeholder='enter name...'
            className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm mb-2 focus:border-zigner-gold focus:outline-none'
            autoFocus
          />
          <div className='flex gap-2'>
            <button
              onClick={async () => {
                if (contactName.trim()) {
                  const newContact = await addContact({ name: contactName.trim() });
                  await addAddress(newContact.id, { network: 'cosmos', address: recipient, chainId: sourceChainId });
                  setShowContactModal(false);
                  setContactName('');
                }
              }}
              disabled={!contactName.trim()}
              className='flex-1 rounded bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-dark disabled:opacity-50'
            >
              save
            </button>
            <button
              onClick={() => {
                setShowContactModal(false);
                setContactName('');
              }}
              className='flex-1 rounded bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground'
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
        </div>
      )}

{/* submit */}
      <button
        onClick={() => {
          if (txStatus === 'success' || txStatus === 'error') {
            setTxStatus('idle');
            setTxHash(undefined);
            setTxError(undefined);
            setShowSavePrompt(false);
            if (txStatus === 'success') {
              setRecipient('');
              setAmount('');
            }
          } else {
            void handleSubmit();
          }
        }}
        disabled={
          (txStatus === 'idle' && !canSubmit) ||
          txStatus === 'signing' ||
          txStatus === 'broadcasting'
        }
        className={cn(
          'mt-2 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
          'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {txStatus === 'signing' && 'signing...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && (routeLoading ? 'finding route...' : 'send')}
        {txStatus === 'success' && 'send another'}
        {txStatus === 'error' && 'retry'}
      </button>

      <p className='text-center text-xs text-muted-foreground'>
        {destChainId && destChainId !== sourceChain.chainId
          ? 'ibc transfer via skip'
          : 'local transfer'}
      </p>
    </div>
  );
}

type PenumbraMode = 'send' | 'ibc';

/** Combined Penumbra send with tabs */
function PenumbraSend() {
  const [mode, setMode] = useState<PenumbraMode>('send');

  return (
    <div className='flex flex-col gap-4'>
      {/* mode tabs */}
      <div className='flex rounded-lg bg-muted/30 p-1'>
        <button
          onClick={() => setMode('send')}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
            mode === 'send'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          send
        </button>
        <button
          onClick={() => setMode('ibc')}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
            mode === 'ibc'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          ibc withdraw
        </button>
      </div>

      {mode === 'send' ? <PenumbraNativeSend /> : <PenumbraIbcSend />}
    </div>
  );
}

/** Penumbra native send form (penumbra -> penumbra) */
function PenumbraNativeSend() {
  const sendState = useStore(selectPenumbraSend);
  const [txStatus, setTxStatus] = useState<'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const [assetOpen, setAssetOpen] = useState(false);

  const penumbraTx = usePenumbraTransaction();

  // fetch balances
  const { data: balances = [], isLoading: balancesLoading } = useQuery({
    queryKey: ['balances', 0],
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const raw = await Array.fromAsync(viewClient.balances({ accountFilter: { account: 0 } }));
        // filter and sort
        return raw
          .filter(b => {
            const meta = getMetadataFromBalancesResponse.optional(b);
            if (!meta?.base || typeof meta.base !== 'string') return true;
            return !(
              assetPatterns.auctionNft.matches(meta.base) ||
              assetPatterns.lpNft.matches(meta.base) ||
              assetPatterns.proposalNft.matches(meta.base) ||
              assetPatterns.votingReceipt.matches(meta.base)
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

  // local state for selected asset (not in zustand due to immer/protobuf incompatibility)
  const [selectedAsset, setSelectedAsset] = useState<typeof balances[0] | undefined>();

  // auto-select first balance if none selected
  useEffect(() => {
    if (!selectedAsset && balances.length > 0) {
      setSelectedAsset(balances[0]);
    }
  }, [balances, selectedAsset]);

  // recent addresses
  const { recordUsage, getRecent } = useStore(recentAddressesSelector);
  const { findByAddress } = useStore(contactsSelector);

  const recentAddresses = useMemo(() => getRecent('penumbra', 3), [getRecent]);

  const addressValid = useMemo(
    () => !sendState.recipient || sendState.recipient.startsWith('penumbra1'),
    [sendState.recipient]
  );

  // get display info for selected asset
  const selectedSymbol = useMemo(() => {
    if (!selectedAsset?.balanceView) return 'asset';
    return getDisplayDenomFromView(selectedAsset.balanceView) || 'asset';
  }, [selectedAsset]);

  const selectedBalance = useMemo(() => {
    if (!selectedAsset?.balanceView) return '0';
    const val = fromValueView(selectedAsset.balanceView);
    return typeof val === 'string' ? val : val.toString();
  }, [selectedAsset]);

  const handleMax = useCallback(() => {
    sendState.setAmount(selectedBalance);
  }, [selectedBalance, sendState]);

  const canSubmit = addressValid && sendState.recipient && selectedAsset && sendState.amount && parseFloat(sendState.amount) > 0 && txStatus === 'idle';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedAsset) return;

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
        <label className='mb-1 block text-xs text-muted-foreground'>asset</label>
        <div className='relative'>
          <button
            onClick={() => setAssetOpen(!assetOpen)}
            disabled={txStatus !== 'idle' || balancesLoading}
            className='flex w-full items-center justify-between rounded-lg border border-border bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50 disabled:opacity-50'
          >
            {balancesLoading ? (
              <span className='text-muted-foreground'>loading...</span>
            ) : selectedAsset ? (
              <span>{selectedSymbol}</span>
            ) : (
              <span className='text-muted-foreground'>select asset</span>
            )}
            <ChevronDownIcon className={cn('h-4 w-4 transition-transform', assetOpen && 'rotate-180')} />
          </button>

          {assetOpen && (
            <div className='absolute top-full left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-background shadow-lg'>
              {balances.map((balance, i) => {
                if (!balance.balanceView) return null;
                const symbol = getDisplayDenomFromView(balance.balanceView) || 'Unknown';
                const amt = fromValueView(balance.balanceView);
                const amountStr = typeof amt === 'string' ? amt : amt.toString();
                return (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedAsset(balance);
                      setAssetOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-muted/50',
                      selectedAsset === balance && 'bg-muted/30'
                    )}
                  >
                    <span>{symbol}</span>
                    <span className='text-muted-foreground'>{amountStr}</span>
                  </button>
                );
              })}
              {balances.length === 0 && (
                <div className='px-3 py-2 text-sm text-muted-foreground'>no assets</div>
              )}
            </div>
          )}
        </div>
        {selectedAsset && (
          <p className='mt-1 text-xs text-muted-foreground'>
            balance: {selectedBalance} {selectedSymbol}
          </p>
        )}
      </div>

      {/* recipient address */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>
          recipient (penumbra1...)
        </label>
        <input
          type='text'
          value={sendState.recipient}
          onChange={e => sendState.setRecipient(e.target.value)}
          placeholder='penumbra1...'
          disabled={txStatus !== 'idle'}
          className={cn(
            'w-full rounded-lg border bg-input px-3 py-2.5 text-sm text-foreground',
            'placeholder:text-muted-foreground transition-colors duration-100',
            'focus:border-zigner-gold focus:outline-none disabled:opacity-50',
            sendState.recipient && !addressValid ? 'border-red-500' : 'border-border'
          )}
        />
        {sendState.recipient && !addressValid && (
          <p className='mt-1 text-xs text-red-500'>invalid penumbra address</p>
        )}
        {/* recent addresses */}
        {!sendState.recipient && recentAddresses.length > 0 && (
          <div className='mt-2'>
            <p className='text-xs text-muted-foreground mb-1'>recent:</p>
            <div className='flex flex-wrap gap-1'>
              {recentAddresses.map(r => {
                const result = findByAddress(r.address);
                return (
                  <button
                    key={r.address}
                    onClick={() => sendState.setRecipient(r.address)}
                    className='rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
                  >
                    {result ? result.contact.name : `${r.address.slice(0, 12)}...${r.address.slice(-4)}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* amount */}
      <div>
        <div className='flex items-center justify-between mb-1'>
          <label className='text-xs text-muted-foreground'>amount</label>
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
          className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none disabled:opacity-50'
        />
      </div>

      {/* memo */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>memo (optional)</label>
        <input
          type='text'
          value={sendState.memo}
          onChange={e => sendState.setMemo(e.target.value)}
          placeholder='optional message'
          disabled={txStatus !== 'idle'}
          className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none disabled:opacity-50'
        />
      </div>

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>
            {txHash}
          </p>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
        </div>
      )}

      {/* submit */}
      <button
        onClick={() => {
          if (txStatus === 'success' || txStatus === 'error') {
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
        className={cn(
          'mt-2 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
          'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {txStatus === 'planning' && 'building plan...'}
        {txStatus === 'signing' && 'signing...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && 'send'}
        {txStatus === 'success' && 'send another'}
        {txStatus === 'error' && 'retry'}
      </button>

      {sendState.error && txStatus === 'idle' && (
        <p className='text-center text-xs text-red-500'>{sendState.error}</p>
      )}

      <p className='text-center text-xs text-muted-foreground'>
        private transfer within penumbra
      </p>
    </div>
  );
}

/** Penumbra IBC send form */
function PenumbraIbcSend() {
  const { data: chains = [], isLoading: chainsLoading } = useIbcChains();
  const ibcState = useStore(selectIbcWithdraw);
  const [txStatus, setTxStatus] = useState<'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'>('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [contactName, setContactName] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);
  const [sentToAddress, setSentToAddress] = useState<string | undefined>();
  const [sentToChainId, setSentToChainId] = useState<string | undefined>();

  const penumbraTx = usePenumbraTransaction();

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave, dismissSuggestion, getRecent } = useStore(recentAddressesSelector);
  const { addContact, addAddress, findByAddress } = useStore(contactsSelector);

  // get recent addresses for cosmos (IBC destinations are cosmos chains)
  const recentAddresses = useMemo(() => getRecent('cosmos', 3), [getRecent]);

  const addressValid = useMemo(
    () => isValidIbcAddress(ibcState.chain, ibcState.destinationAddress),
    [ibcState.chain, ibcState.destinationAddress]
  );

  const canSubmit = ibcState.chain && addressValid && ibcState.amount && parseFloat(ibcState.amount) > 0 && txStatus === 'idle';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setTxStatus('planning');
    setTxError(undefined);

    try {
      const planRequest = await ibcState.buildPlanRequest();
      setTxStatus('signing');

      const result = await penumbraTx.mutateAsync(planRequest);

      setTxStatus('success');
      setTxHash(result.txId);

      // record address usage
      const destAddr = ibcState.destinationAddress;
      const chainId = ibcState.chain?.chainId;
      setSentToAddress(destAddr);
      setSentToChainId(chainId);
      void recordUsage(destAddr, 'cosmos', chainId);
      // check if we should prompt to save as contact
      if (shouldSuggestSave(destAddr)) {
        setShowSavePrompt(true);
      }

      // reset form after success
      ibcState.reset();
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'transaction failed');
    }
  }, [canSubmit, ibcState, penumbraTx, recordUsage, shouldSuggestSave]);

  const handleReset = useCallback(() => {
    setTxStatus('idle');
    setTxHash(undefined);
    setTxError(undefined);
    setShowSavePrompt(false);
    setSentToAddress(undefined);
    setSentToChainId(undefined);
  }, []);

  return (
    <div className='flex flex-col gap-4'>
      {/* chain selector */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>destination chain</label>
        {chainsLoading ? (
          <div className='h-10 rounded-lg bg-muted/30 animate-pulse' />
        ) : (
          <ChainSelector
            chains={chains}
            selected={ibcState.chain}
            onSelect={ibcState.setChain}
          />
        )}
      </div>

      {/* destination address */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>
          recipient {ibcState.chain && `(${ibcState.chain.addressPrefix}1...)`}
        </label>
        <input
          type='text'
          value={ibcState.destinationAddress}
          onChange={e => ibcState.setDestinationAddress(e.target.value)}
          placeholder={ibcState.chain ? `${ibcState.chain.addressPrefix}1...` : 'select chain first'}
          disabled={!ibcState.chain || txStatus !== 'idle'}
          className={cn(
            'w-full rounded-lg border bg-input px-3 py-2.5 text-sm text-foreground',
            'placeholder:text-muted-foreground transition-colors duration-100',
            'focus:border-zigner-gold focus:outline-none disabled:opacity-50',
            ibcState.destinationAddress && !addressValid ? 'border-red-500' : 'border-border'
          )}
        />
        {ibcState.destinationAddress && !addressValid && (
          <p className='mt-1 text-xs text-red-500'>invalid address for {ibcState.chain?.displayName}</p>
        )}
        {/* recent addresses */}
        {!ibcState.destinationAddress && recentAddresses.length > 0 && (
          <div className='mt-2'>
            <p className='text-xs text-muted-foreground mb-1'>recent:</p>
            <div className='flex flex-wrap gap-1'>
              {recentAddresses.map(r => {
                const result = findByAddress(r.address);
                return (
                  <button
                    key={r.address}
                    onClick={() => ibcState.setDestinationAddress(r.address)}
                    className='rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors'
                  >
                    {result ? result.contact.name : `${r.address.slice(0, 8)}...${r.address.slice(-4)}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* amount */}
      <div>
        <label className='mb-1 block text-xs text-muted-foreground'>amount</label>
        <input
          type='text'
          value={ibcState.amount}
          onChange={e => ibcState.setAmount(e.target.value)}
          placeholder='0.00'
          disabled={txStatus !== 'idle'}
          className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none disabled:opacity-50'
        />
      </div>

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/30 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-muted-foreground mt-1 font-mono break-all'>
            {txHash}
          </p>
        </div>
      )}

      {/* save contact prompt */}
      {showSavePrompt && sentToAddress && !findByAddress(sentToAddress) && !showContactModal && (
        <SaveContactPrompt
          address={sentToAddress}
          network='cosmos'
          onSave={() => {
            setShowSavePrompt(false);
            setShowContactModal(true);
          }}
          onDismiss={() => {
            void dismissSuggestion(sentToAddress);
            setShowSavePrompt(false);
          }}
        />
      )}

      {/* contact name modal */}
      {showContactModal && sentToAddress && (
        <div className='rounded-lg border border-border bg-background p-3'>
          <p className='text-sm font-medium mb-2'>name this contact</p>
          <input
            type='text'
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            placeholder='enter name...'
            className='w-full rounded-lg border border-border bg-input px-3 py-2 text-sm mb-2 focus:border-zigner-gold focus:outline-none'
            autoFocus
          />
          <div className='flex gap-2'>
            <button
              onClick={async () => {
                if (contactName.trim()) {
                  const newContact = await addContact({ name: contactName.trim() });
                  await addAddress(newContact.id, { network: 'cosmos', address: sentToAddress, chainId: sentToChainId });
                  setShowContactModal(false);
                  setContactName('');
                }
              }}
              disabled={!contactName.trim()}
              className='flex-1 rounded bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-dark disabled:opacity-50'
            >
              save
            </button>
            <button
              onClick={() => {
                setShowContactModal(false);
                setContactName('');
              }}
              className='flex-1 rounded bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground'
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/30 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-muted-foreground mt-1'>{txError}</p>
        </div>
      )}

      {/* submit */}
      <button
        onClick={() => {
          if (txStatus === 'success' || txStatus === 'error') {
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
        className={cn(
          'mt-2 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark',
          'transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {txStatus === 'planning' && 'building plan...'}
        {txStatus === 'signing' && 'signing...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && 'send via ibc'}
        {txStatus === 'success' && 'send another'}
        {txStatus === 'error' && 'retry'}
      </button>

      {ibcState.error && txStatus === 'idle' && (
        <p className='text-center text-xs text-red-500'>{ibcState.error}</p>
      )}

      <p className='text-center text-xs text-muted-foreground'>
        ibc withdrawal from penumbra to {ibcState.chain?.displayName ?? 'cosmos chain'}
      </p>
    </div>
  );
}

const COSMOS_CHAIN_IDS: CosmosChainId[] = ['osmosis', 'noble', 'nomic', 'celestia'];

/** location state for prefilling forms from inbox */
interface SendLocationState {
  prefillMemo?: string;
  prefillRecipient?: string;
  prefillAmount?: string;
}

export function SendPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { activeNetwork } = useStore(activeNetworkSelector);

  // get prefill from location state (from inbox compose)
  const locationState = location.state as SendLocationState | undefined;
  const prefill = locationState ? {
    recipient: locationState.prefillRecipient,
    amount: locationState.prefillAmount,
    memo: locationState.prefillMemo,
  } : undefined;

  const goBack = () => navigate(PopupPath.INDEX);
  const isPenumbra = activeNetwork === 'penumbra';
  const isCosmos = COSMOS_CHAIN_IDS.includes(activeNetwork as CosmosChainId);
  const isZcash = activeNetwork === 'zcash';

  const getTitle = () => {
    if (isPenumbra) return 'send penumbra';
    if (isCosmos) return 'send';
    if (isZcash) return 'send zcash';
    return `send ${activeNetwork}`;
  };

  // zcash uses full-screen flow
  if (isZcash) {
    return (
      <ZcashSend
        onClose={goBack}
        accountIndex={0}
        mainnet={true}
        prefill={prefill}
      />
    );
  }

  return (
    <div className='flex flex-col'>
      {/* Header */}
      <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={goBack}
          className='text-muted-foreground transition-colors duration-75 hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-foreground'>{getTitle()}</h1>
      </div>

      {/* Content */}
      <div className='p-4'>
        {isPenumbra ? (
          <PenumbraSend />
        ) : isCosmos ? (
          <CosmosSend sourceChainId={activeNetwork as CosmosChainId} />
        ) : (
          <div className='flex flex-col gap-4'>
            <div>
              <label className='mb-1 block text-xs text-muted-foreground'>recipient</label>
              <input
                type='text'
                placeholder='enter address'
                className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none'
              />
            </div>

            <div>
              <label className='mb-1 block text-xs text-muted-foreground'>amount</label>
              <input
                type='text'
                placeholder='0.00'
                className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none'
              />
            </div>

            <button className='mt-4 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]'>
              continue
            </button>

            <p className='text-center text-xs text-muted-foreground'>
              {activeNetwork === 'polkadot' && 'light client transaction'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default SendPage;
