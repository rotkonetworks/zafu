/**
 * penumbra IBC withdraw form
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Sensitive } from '../../../components/sensitive';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../../../state';
import { selectPenumbraAccount } from '../../../state/keyring';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { selectIbcWithdraw } from '../../../state/ibc-withdraw';
import { isValidWithdrawAmount } from '../../../state/ibc-withdraw-amount';
import { useIbcChains, isValidIbcAddress, type IbcChain } from '../../../hooks/ibc-chains';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomExponent } from '@penumbra-zone/getters/metadata';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { trackUnshieldOut } from '../../../state/ibc-transfer-probes';
import { IbcTransferStatusLine } from '../ibc-transfer-status';
import { RegistryIcon } from '../../../shared/components/registry-icon';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { AssetIcon } from '@repo/ui/components/ui/asset-icon';
import { symbolFromMetadata } from '../../../utils/asset-display';
import { selectWithdrawableBalances } from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { allocateTransparentAddress } from '../../../transparent/hd';
import { RecipientPicker } from '../../../components/recipient-picker';

import { EMPTY_BALANCES, SaveContactPrompt } from './shared';

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
        className='flex w-full items-center justify-between border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        {selected ? (
          <span>{selected.displayName}</span>
        ) : (
          <span className='text-fg-muted'>select chain</span>
        )}
        <span
          className={cn('i-ph-caret-down h-4 w-4 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-50 mt-1 border border-border-soft bg-canvas shadow-lg overflow-hidden'>
          {chains.map(chain => (
            <button
              key={chain.chainId}
              onClick={() => {
                onSelect(chain);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-elev-1',
                selected?.chainId === chain.chainId && 'bg-elev-2',
              )}
            >
              <RegistryIcon
                name={chain.displayName}
                images={chain.images}
                className='h-5 w-5'
                size={20}
              />
              <span>{chain.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Penumbra IBC send form */
/** filter balances to assets withdrawable through a given IBC channel */
const filterWithdrawableAssets = <T,>(balances: T[], channelId: string | undefined): T[] => {
  if (!channelId) {
    return balances;
  }
  const prefix = `transfer/${channelId}/`;
  return balances.filter(b => {
    const base =
      (b as any)?.balanceView?.valueView?.value?.metadata?.base ??
      getMetadataFromBalancesResponse.optional(b as any)?.base;
    if (!base) {
      return false;
    }
    // show assets that came through this channel (can unwind back)
    // plus native UM (can always send cross-chain)
    return base.startsWith(prefix) || base === 'upenumbra';
  });
};

/**
 * Minimum USDC to unshield to Noble. Noble's per-tx fee is ~0.15-0.16 USDC;
 * anything at or below that would land a burner that can never afford to move
 * again. 0.2 clears the fee with margin.
 */
const MIN_NOBLE_USDC_UNSHIELD = 0.2;

export function PenumbraIbcSend({ onSuccess }: { onSuccess?: () => void }) {
  const { data: chains = [], isLoading: chainsLoading } = useIbcChains();
  const ibcState = useStore(selectIbcWithdraw);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [txStatus, setTxStatus] = useState<
    'idle' | 'planning' | 'signing' | 'broadcasting' | 'success' | 'error'
  >('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [contactName, setContactName] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);
  const [sentToAddress, setSentToAddress] = useState<string | undefined>();
  const [sentToChainId, setSentToChainId] = useState<string | undefined>();
  const [assetOpen, setAssetOpen] = useState(false);
  // id of the pending IBC transfer this success view is tracking (undefined once reset)
  const [trackedTransferId, setTrackedTransferId] = useState<string | undefined>();
  // opt-in: send to a hand-entered address instead of our own burner deposit
  // address. Off by default - unshielding lands in our transparent burner.
  const [overrideAddress, setOverrideAddress] = useState(false);

  const penumbraTx = usePenumbraTransaction();

  // fetch balances for asset selection
  // Shared RAW ['balances', account] cache; `select` excludes non-fungible
  // synthetic tokens (LP NFTs, delegation, etc.) and any balance we can't
  // classify (no metadata = not withdrawable) per observer.
  const { data: allBalances = EMPTY_BALANCES } = useQuery({
    ...balancesQueryOptions(penumbraAccount),
    staleTime: 30_000,
    select: selectWithdrawableBalances,
  });

  // Default the destination to Noble - the transparent USDC off-ramp is the
  // overwhelmingly common unshield target, so preselecting it saves a dropdown
  // trip every time. Only fills the empty state: an explicit pick (persisted in
  // the ibcWithdraw slice) is never overridden, and matching on addressPrefix
  // keeps this correct if more IBC chains go live later.
  useEffect(() => {
    if (ibcState.chain) {
      return;
    }
    // Injective first: it is the live ramp; Circle is winding USDC down on Noble
    const preferred =
      chains.find(c => c.addressPrefix === 'inj') ?? chains.find(c => c.addressPrefix === 'noble');
    if (preferred) {
      ibcState.setChain(preferred);
    }
  }, [chains, ibcState.chain, ibcState.setChain]);

  // filter to withdrawable assets for selected chain
  const withdrawableAssets = useMemo(
    () => filterWithdrawableAssets(allBalances, ibcState.chain?.channelId),
    [allBalances, ibcState.chain?.channelId],
  );

  const [selectedAsset, setSelectedAsset] = useState<(typeof allBalances)[0] | undefined>();

  // auto-select first withdrawable asset when chain changes
  useEffect(() => {
    if (withdrawableAssets.length > 0) {
      const meta = getMetadataFromBalancesResponse.optional(withdrawableAssets[0]);
      setSelectedAsset(withdrawableAssets[0]);
      if (meta?.base) {
        ibcState.setDenom(meta.base, getDisplayDenomExponent.optional(meta));
      }
    } else {
      setSelectedAsset(undefined);
      ibcState.setDenom('', undefined);
    }
  }, [ibcState.chain?.channelId, withdrawableAssets.length]);

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave, dismissSuggestion } = useStore(recentAddressesSelector);
  const { addContact, addAddress, findByAddress } = useStore(contactsSelector);

  const addressValid = useMemo(
    () => isValidIbcAddress(ibcState.chain, ibcState.destinationAddress),
    [ibcState.chain, ibcState.destinationAddress],
  );

  // The destination is our own burner deposit address on the counterparty chain
  // (Noble etc.) by default - unshielding is an off-ramp INTO the burner, not a
  // send to a stranger. Derive the cosmos chain id from the IBC chain's prefix.
  //
  // The transparent chain this withdrawal lands on, found by bech32 prefix
  // ('inj' is keyed 'injective', so match on the config, not the key).
  const destPrefix = ibcState.chain?.addressPrefix;
  const cosmosChainId = destPrefix
    ? Object.values(COSMOS_CHAINS).find(c => c.bech32Prefix === destPrefix)?.id
    : undefined;

  // Own address to offer as the one-tap target. Mnemonic vaults get a FRESH HD
  // address (a new one each unshield, never shown twice), derived by the
  // chain's conduit so Injective stays on coin type 60, and remembered as shown
  // so it is always scanned. Zigner (cold) vaults can't derive in-app, so fall
  // back to the watch-only address the device exported at import - coin-118
  // chains only: zigner has no valid key for an Ethermint chain.
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const storedOwnAddress = useMemo(() => {
    if (
      selectedKeyInfo?.type !== 'zigner-zafu' ||
      !ibcState.chain ||
      (cosmosChainId && COSMOS_CHAINS[cosmosChainId].keyAlgo === 'eth_secp256k1')
    ) {
      return undefined;
    }
    const addrs = selectedKeyInfo.insensitive['cosmosAddresses'] as
      | { chainId: string; address: string; prefix: string }[]
      | undefined;
    return addrs?.find(a => a.prefix === ibcState.chain!.addressPrefix)?.address;
  }, [selectedKeyInfo, ibcState.chain, cosmosChainId]);
  const { getMnemonic } = useStore(keyRingSelector);
  const [freshOwnAddress, setFreshOwnAddress] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setFreshOwnAddress(undefined);
    const keyId = selectedKeyInfo?.type === 'mnemonic' ? selectedKeyInfo.id : undefined;
    if (!cosmosChainId || !keyId) {
      return;
    }
    void (async () => {
      // key first: allocating while locked would burn an index nobody sees
      const mnemonic = await getMnemonic(keyId).catch(() => undefined);
      if (!mnemonic || cancelled) {
        return;
      }
      const { address } = await allocateTransparentAddress(cosmosChainId, keyId, mnemonic);
      if (!cancelled) {
        setFreshOwnAddress(address);
      }
    })().catch(err => console.warn('[send] failed to allocate an own address:', err));
    return () => {
      cancelled = true;
    };
  }, [cosmosChainId, selectedKeyInfo?.id, selectedKeyInfo?.type, getMnemonic]);
  const ownAddress = freshOwnAddress ?? storedOwnAddress;
  // chain the arrival tracker polls
  const trackChainId: CosmosChainId | undefined = cosmosChainId;

  // when we have our own address and the user hasn't opted into a custom
  // recipient, keep the destination pinned to it
  useEffect(() => {
    if (ownAddress && !overrideAddress && ibcState.destinationAddress !== ownAddress) {
      ibcState.setDestinationAddress(ownAddress);
    }
  }, [ownAddress, overrideAddress]);

  // Noble charges a ~0.15-0.16 USDC fee per tx, so unshielding less than that
  // strands the balance: the burner can never cover its own fee to move again.
  // Require a floor that comfortably clears the fee.
  const isNobleUsdc = useMemo(() => {
    if (ibcState.chain?.addressPrefix !== 'noble' || !selectedAsset) {
      return false;
    }
    const meta = getMetadataFromBalancesResponse.optional(selectedAsset);
    const sym = (meta?.symbol ?? meta?.display ?? ibcState.denom ?? '').toUpperCase();
    return sym.includes('USDC');
  }, [ibcState.chain, ibcState.denom, selectedAsset]);
  const belowNobleMin =
    isNobleUsdc && !!ibcState.amount && parseFloat(ibcState.amount) < MIN_NOBLE_USDC_UNSHIELD;

  // spendable display-unit balance of the selected asset, from the same
  // viewClient.balances source the asset list is built from (no separate balance
  // math). Mirrors PenumbraNativeSend's selectedBalance.
  const selectedBalance = useMemo(() => {
    if (!selectedAsset?.balanceView) {
      return '0';
    }
    const val = fromValueView(selectedAsset.balanceView);
    return typeof val === 'string' ? val : val.toString();
  }, [selectedAsset]);

  const handleMax = useCallback(() => {
    // Fill the FULL spendable balance of the selected asset, mirroring the max in
    // native-send and cosmos-send. No fee is reserved here on purpose: Penumbra
    // fees are a separate spend the planner adds (normally from UM), so maxing a
    // NON-UM asset (e.g. USDC out to Noble) is planner-safe. Maxing UM itself
    // leaves nothing for the UM fee and the planner rejects the plan - it can
    // never overspend, and the amount only moves on the user's explicit tap.
    //
    // NOTE (18-decimal assets, e.g. injective INJ once live): a display balance
    // below 1e-6 stringifies to exponent notation ("1e-7"), which
    // isValidWithdrawAmount rejects (its grammar has no exponent). Harmless while
    // only 6-decimal assets (UM, USDC) are live; revisit if an 18-dec asset ships.
    ibcState.setAmount(selectedBalance);
  }, [selectedBalance, ibcState]);

  // Amount must be expressible in the asset's own base units: more fractional
  // digits than the exponent allows is a user error we surface up front rather
  // than silently truncating at plan time.
  const amountValid =
    ibcState.exponent !== undefined && isValidWithdrawAmount(ibcState.amount, ibcState.exponent);

  const canSubmit =
    ibcState.chain && addressValid && amountValid && !belowNobleMin && txStatus === 'idle';

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }

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

      // start tracking arrival on the destination cosmos chain (the relayer has
      // no status API, so we poll the burner/recipient balance). Capture the
      // fields BEFORE ibcState.reset() clears them. Best-effort + non-blocking.
      if (result.txId && trackChainId) {
        const meta = selectedAsset
          ? getMetadataFromBalancesResponse.optional(selectedAsset)
          : undefined;
        void trackUnshieldOut({
          srcTxHash: result.txId,
          amount: ibcState.amount,
          // the ASSET's decimals: INJ is 18, USDC.inj 6 - the chain's native
          // decimals mis-sized the expected arrival for anything else
          decimals: ibcState.exponent ?? COSMOS_CHAINS[trackChainId].decimals,
          symbol: meta?.symbol ?? meta?.display ?? ibcState.denom,
          destChainId: trackChainId,
          destAddress: destAddr,
          isNative: isNobleUsdc,
        })
          .then(() => setTrackedTransferId(result.txId))
          .catch(err => console.warn('failed to track unshield transfer:', err));
      }

      // reset form after success
      ibcState.reset();
    } catch (err) {
      setTxStatus('error');
      const msg = err instanceof Error ? err.message : 'transaction failed';
      setTxError(
        msg.includes('expired')
          ? `${ibcState.chain?.displayName ?? 'IBC'} channel unavailable - client expired`
          : msg,
      );
    }
  }, [
    canSubmit,
    ibcState,
    penumbraTx,
    recordUsage,
    shouldSuggestSave,
    cosmosChainId,
    selectedAsset,
    isNobleUsdc,
  ]);

  const handleReset = useCallback(() => {
    setTxStatus('idle');
    setTxHash(undefined);
    setTxError(undefined);
    setShowSavePrompt(false);
    setSentToAddress(undefined);
    setSentToChainId(undefined);
    setTrackedTransferId(undefined);
  }, []);

  return (
    <div className='flex flex-col gap-4'>
      {/* chain selector */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>destination chain</label>
        {chainsLoading ? (
          <div className='h-10 bg-elev-2 animate-pulse' />
        ) : (
          <ChainSelector chains={chains} selected={ibcState.chain} onSelect={ibcState.setChain} />
        )}
      </div>

      {/* destination address - our burner deposit address by default */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>
          recipient {ibcState.chain && `(${ibcState.chain.addressPrefix}1...)`}
        </label>
        {ownAddress && !overrideAddress ? (
          <div className='border border-border-soft bg-input px-3 py-2.5'>
            <div className='flex items-center justify-between gap-2'>
              <span className='text-label text-fg-muted lowercase'>your deposit address</span>
              <span className='bg-red-500/10 px-1.5 py-0.5 text-label leading-none text-red-400 lowercase'>
                transparent
              </span>
            </div>
            <p className='mt-1 break-all font-mono text-xs text-fg' title={ownAddress}>
              {ownAddress}
            </p>
            <button
              type='button'
              onClick={() => {
                setOverrideAddress(true);
                ibcState.setDestinationAddress('');
              }}
              disabled={txStatus !== 'idle'}
              className='mt-1.5 text-label text-network-accent transition-colors hover:text-fg-high disabled:opacity-50'
            >
              send to a different address
            </button>
          </div>
        ) : (
          <>
            <input
              type='text'
              value={ibcState.destinationAddress}
              onChange={e => ibcState.setDestinationAddress(e.target.value)}
              placeholder={
                ibcState.chain ? `${ibcState.chain.addressPrefix}1...` : 'select chain first'
              }
              disabled={!ibcState.chain || txStatus !== 'idle'}
              className={cn(
                'w-full border bg-input px-3 py-2.5 text-sm text-fg',
                'placeholder:text-fg-muted transition-colors duration-100',
                'focus:border-penumbra-purple focus:outline-none disabled:opacity-50',
                ibcState.destinationAddress && !addressValid
                  ? 'border-red-400'
                  : 'border-border-soft',
              )}
            />
            {ibcState.destinationAddress && !addressValid && (
              <p className='mt-1 text-xs text-red-400'>
                invalid address for {ibcState.chain?.displayName}
              </p>
            )}
            <RecipientPicker
              network='cosmos'
              onSelect={ibcState.setDestinationAddress}
              show={!ibcState.destinationAddress}
            />
            {ownAddress && (
              <button
                type='button'
                onClick={() => {
                  setOverrideAddress(false);
                  ibcState.setDestinationAddress(ownAddress);
                }}
                disabled={txStatus !== 'idle'}
                className='mt-1.5 text-label text-network-accent transition-colors hover:text-fg-high disabled:opacity-50'
              >
                use my deposit address
              </button>
            )}
          </>
        )}
      </div>

      {/* asset selector */}
      {ibcState.chain && (
        <div>
          <label className='mb-1 block text-xs text-fg-muted'>asset</label>
          {withdrawableAssets.length === 0 ? (
            <p className='text-xs text-fg-dim py-2'>
              no withdrawable assets for {ibcState.chain.displayName}
            </p>
          ) : (
            <div className='relative'>
              <button
                onClick={() => setAssetOpen(!assetOpen)}
                disabled={txStatus !== 'idle'}
                className='flex w-full items-center gap-1.5 border border-border-soft bg-input px-3 py-2.5 text-sm text-fg text-left disabled:opacity-50'
              >
                {selectedAsset ? (
                  <>
                    <AssetIcon
                      metadata={getMetadataFromBalancesResponse.optional(selectedAsset)}
                      size='xs'
                    />
                    {symbolFromMetadata(getMetadataFromBalancesResponse.optional(selectedAsset))}
                  </>
                ) : (
                  'select asset'
                )}
              </button>
              {assetOpen && (
                <div className='absolute z-10 mt-1 w-full border border-border-soft bg-canvas shadow-lg max-h-48 overflow-y-auto'>
                  {withdrawableAssets.map((b, i) => {
                    const meta = getMetadataFromBalancesResponse.optional(b);
                    const display = symbolFromMetadata(meta);
                    return (
                      <button
                        key={i}
                        onClick={() => {
                          setSelectedAsset(b);
                          if (meta?.base) {
                            ibcState.setDenom(meta.base, getDisplayDenomExponent.optional(meta));
                          }
                          setAssetOpen(false);
                        }}
                        className='w-full px-3 py-2 text-left text-sm hover:bg-elev-1 flex justify-between items-center'
                      >
                        <span className='flex items-center gap-1.5'>
                          <AssetIcon metadata={meta} size='xs' />
                          {display}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* amount */}
      <div>
        <div className='mb-1 flex items-center justify-between'>
          <label className='text-xs text-fg-muted'>amount</label>
          {selectedAsset && (
            <div className='flex items-center gap-2'>
              <span className='text-xs text-fg-muted'>
                balance: <Sensitive>{selectedBalance}</Sensitive>
              </span>
              <button
                type='button'
                onClick={handleMax}
                disabled={txStatus !== 'idle'}
                className='text-xs text-zigner-gold hover:text-zigner-gold-light disabled:opacity-50'
              >
                max
              </button>
            </div>
          )}
        </div>
        <input
          type='text'
          value={ibcState.amount}
          onChange={e => ibcState.setAmount(e.target.value)}
          placeholder='0.00'
          disabled={txStatus !== 'idle'}
          className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none disabled:opacity-50'
        />
        {belowNobleMin && (
          <p className='mt-1 text-xs text-red-400'>
            minimum {MIN_NOBLE_USDC_UNSHIELD} USDC - Noble's ~0.16 USDC fee would otherwise strand
            the balance
          </p>
        )}
        {!belowNobleMin && !!ibcState.amount && !amountValid && (
          <p className='mt-1 text-xs text-red-400'>
            {ibcState.exponent === undefined
              ? 'no decimals known for this asset - pick it again'
              : `enter a positive amount with at most ${ibcState.exponent} decimal places`}
          </p>
        )}
      </div>

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='border border-green-500/40 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-fg-muted mt-1 font-mono break-all'>{txHash}</p>
          <IbcTransferStatusLine transferId={trackedTransferId} />
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
        <div className='border border-border-soft bg-canvas p-3'>
          <p className='text-sm font-medium mb-2'>name this contact</p>
          <input
            type='text'
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            placeholder='enter name...'
            className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm mb-2 focus:border-penumbra-purple focus:outline-none'
            autoFocus
          />
          <div className='flex gap-2'>
            <button
              onClick={async () => {
                if (contactName.trim()) {
                  const newContact = await addContact({ name: contactName.trim() });
                  await addAddress(newContact.id, {
                    network: 'cosmos',
                    address: sentToAddress,
                    chainId: sentToChainId,
                  });
                  setShowContactModal(false);
                  setContactName('');
                }
              }}
              disabled={!contactName.trim()}
              className='flex-1 bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-gold-foreground transition-colors disabled:opacity-50'
            >
              save
            </button>
            <button
              onClick={() => {
                setShowContactModal(false);
                setContactName('');
              }}
              className='flex-1 bg-elev-2 px-3 py-1.5 text-xs text-fg-muted transition-colors'
            >
              cancel
            </button>
          </div>
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
        {txStatus === 'idle' && 'send via ibc'}
        {txStatus === 'success' && (onSuccess ? 'close' : 'send another')}
        {txStatus === 'error' && 'retry'}
      </Button>

      {ibcState.error && txStatus === 'idle' && (
        <p className='text-center text-xs text-red-400'>{ibcState.error}</p>
      )}

      <p className='text-center text-xs text-fg-muted'>
        ibc withdrawal from penumbra to {ibcState.chain?.displayName ?? 'cosmos chain'}
      </p>
    </div>
  );
}

/** location state for prefilling forms from inbox */
