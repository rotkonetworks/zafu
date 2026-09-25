/**
 * multi-network send screen
 * penumbra supports IBC withdrawals to cosmos chains
 * cosmos chains use skip go api for routing
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Sensitive } from '../../../components/sensitive';
import { PopupPath } from '../paths';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ZcashSend } from './zcash-send';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { recentAddressesSelector, type AddressNetwork } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { selectIbcWithdraw } from '../../../state/ibc-withdraw';
import { isValidWithdrawAmount } from '../../../state/ibc-withdraw-amount';
import { isActiveIbcChain, getNetwork, getActiveIbcSubnetworks } from '../../../config/networks';
import type { NetworkType } from '../../../state/keyring';
import { selectPenumbraSend } from '../../../state/penumbra-send';
import { useIbcChains, isValidIbcAddress, type IbcChain } from '../../../hooks/ibc-chains';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomExponent } from '@penumbra-zone/getters/metadata';
import { fromValueView } from '@rotko/penumbra-types/amount';
import { useSkipRoute, useSkipChains } from '../../../hooks/skip-route';
import {
  useCosmosSend,
  useCosmosIbcTransfer,
  type CosmosTxResult,
  type CosmosZignerSignResult,
} from '../../../hooks/cosmos-signer';
import { trackTx } from '../../../tx-ops';
import { parseAmountToBaseUnits } from '@repo/wallet/networks/cosmos/signer';
import {
  useCosmosAssets,
  useCosmosDepositWallets,
  type CosmosAsset,
} from '../../../hooks/cosmos-balance';
import { usePenumbraTransaction } from '../../../hooks/penumbra-transaction';
import { trackUnshieldOut } from '../../../state/ibc-transfer-probes';
import { IbcTransferStatusLine } from '../ibc-transfer-status';
import {
  COSMOS_CHAINS,
  type CosmosChainId,
  isValidCosmosAddress,
  getChainFromAddress,
} from '@repo/wallet/networks/cosmos/chains';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { AssetIcon } from '@repo/ui/components/ui/asset-icon';
import { symbolFromMetadata } from '../../../utils/asset-display';
import {
  isPositionBalance,
  positionLabel,
  selectPickerBuckets,
  selectWithdrawableBalances,
} from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import { AssetBucketToggle, type AssetBucket } from '../../../components/asset-bucket-toggle';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { usePasswordGate } from '../../../hooks/password-gate';
import { isDedicatedWindow } from '../../../utils/popup-detection';
import { openInDedicatedWindow } from '../../../utils/navigate';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { useGasSponsor } from '../../../transparent/sponsor';
import { formatBaseUnits, fullDecimalString } from '../../../transparent/assets';
import { allocateTransparentAddress, shortAddress } from '../../../transparent/hd';
import {
  parseInjectiveRecipient,
  type InjectiveRecipientProblem,
} from '@repo/wallet/networks/injective/derive';
import { derivePenumbraEphemeralFromMnemonic } from '../../../hooks/use-address';
import { RecipientPicker } from '../../../components/recipient-picker';
import { QrScanner } from '../../../shared/components/qr-scanner';

/** stable empty list so memo/effect deps don't churn while balances load */
const EMPTY_BALANCES: BalancesResponse[] = [];

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
        className='flex w-full items-center justify-between rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
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
        <div className='absolute top-full left-0 right-0 z-50 mt-1 rounded-lg border border-border-soft bg-canvas shadow-lg overflow-hidden'>
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
    return <div className='h-10 rounded-lg bg-elev-2 animate-pulse' />;
  }

  if (assets.length === 0) {
    return (
      <div className='rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg-muted'>
        no assets
      </div>
    );
  }

  return (
    <div className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center justify-between rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        {selected ? (
          <div className='flex items-center gap-2'>
            <span className='font-medium'>{selected.symbol}</span>
            <span className='text-fg-muted'>
              <Sensitive>{selected.formatted}</Sensitive>
            </span>
          </div>
        ) : (
          <span className='text-fg-muted'>select asset</span>
        )}
        <span
          className={cn('i-ph-caret-down h-4 w-4 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border-soft bg-canvas shadow-lg'>
          {assets.map(asset => (
            <button
              key={asset.denom}
              onClick={() => {
                onSelect(asset);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-elev-1',
                selected?.denom === asset.denom && 'bg-elev-2',
              )}
            >
              <span className='font-medium'>{asset.symbol}</span>
              <span className='text-fg-muted'>
                <Sensitive>{asset.formatted}</Sensitive>
              </span>
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
  autoLabel,
}: {
  chains: { chainId: string; chainName: string; bech32Prefix?: string; logoUri?: string }[];
  selected: string | undefined;
  onSelect: (chainId: string) => void;
  currentChainId: string;
  autoLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [manuallySelected, setManuallySelected] = useState(false);
  const filteredChains = chains.filter(c => c.chainId !== currentChainId);

  const displayName =
    manuallySelected && selected
      ? (chains.find(c => c.chainId === selected)?.chainName ?? selected)
      : selected
        ? (autoLabel ?? chains.find(c => c.chainId === selected)?.chainName ?? selected)
        : (autoLabel ?? 'auto-detect from address');

  return (
    <div className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center justify-between rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        <span className={!manuallySelected && !selected ? 'text-fg-muted' : ''}>{displayName}</span>
        <span
          className={cn('i-ph-caret-down h-4 w-4 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-border-soft bg-canvas shadow-lg'>
          {/* auto-detect option */}
          <button
            onClick={() => {
              onSelect('');
              setManuallySelected(false);
              setOpen(false);
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-elev-1',
              !manuallySelected && 'bg-elev-2',
            )}
          >
            <span className='text-fg-muted'>auto-detect from address</span>
          </button>
          {filteredChains.map(chain => (
            <button
              key={chain.chainId}
              onClick={() => {
                onSelect(chain.chainId);
                setManuallySelected(true);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-elev-1',
                manuallySelected && selected === chain.chainId && 'bg-elev-2',
              )}
            >
              {chain.logoUri && <img src={chain.logoUri} alt='' className='h-5 w-5 rounded-full' />}
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
          <span className='i-ph-user h-4 w-4 text-zigner-gold' />
          <div>
            <p className='text-sm text-fg'>save to contacts?</p>
            <p className='text-xs text-fg-muted'>you've sent to this address before</p>
          </div>
        </div>
        <button onClick={onDismiss} className='text-fg-muted hover:text-fg-high transition-colors'>
          <span className='i-ph-x h-4 w-4' />
        </button>
      </div>
      <div className='mt-2 flex gap-2'>
        <button
          onClick={onSave}
          className='flex-1 rounded-md bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-gold-foreground transition-colors hover:bg-zigner-gold-light'
        >
          save contact
        </button>
        <button
          onClick={onDismiss}
          className='flex-1 rounded-md bg-elev-2 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-elev-1/80 hover:text-fg-high'
        >
          not now
        </button>
      </div>
    </div>
  );
}

// Penumbra's Skip/registry chain id. Shielding USDC INTO penumbra is a direct
// single-hop IBC MsgTransfer over our own relayed channel, NOT a Skip route -
// so this id is special-cased throughout the cosmos send flow below.
const PENUMBRA_CHAIN_ID = 'penumbra-1';

/** cosmos send form with skip routing */
/**
 * Loaded lazily and defensively ON PURPOSE. This module also hosts
 * PenumbraSend, PenumbraNativeSend and ZcashSend, so a module-scope
 * `import ... from 'bip39'` would let a failure in a Cosmos-only
 * convenience take down sending on every other network. Worst case here
 * is that the mnemonic check silently does nothing.
 */
let bip39WordCache: Set<string> | null | undefined;
const bip39Words = (): Set<string> | null => {
  if (bip39WordCache !== undefined) {
    return bip39WordCache;
  }
  try {
    // keep this off the module's static import graph; see comment above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { wordlists } = require('bip39') as { wordlists: Record<string, string[]> };
    bip39WordCache = new Set(wordlists['english'] ?? []);
  } catch {
    bip39WordCache = null;
  }
  return bip39WordCache;
};

/**
 * Memos are the one free-text field whose contents become permanent and
 * public the moment the tx is broadcast, so a paste-slip is unrecoverable.
 * Keplr guards the specific slip people actually make — pasting a seed
 * phrase in — by rejecting a memo that is mostly BIP-39 words. Same rule
 * here: 8-32 words and at least three quarters of them in the wordlist.
 */
const memoLooksLikeMnemonic = (memo: string): boolean => {
  const words = memo
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0);
  if (words.length < 8 || words.length > 32) {
    return false;
  }
  const wordSet = bip39Words();
  if (!wordSet) {
    return false;
  }
  const threshold = (words.length / 4) * 3;
  let hits = 0;
  for (const word of words) {
    if (wordSet.has(word.toLowerCase())) {
      hits++;
    }
  }
  return hits >= threshold;
};

/** one short line per way a pasted Injective recipient can be wrong */
const ETHERMINT_RECIPIENT_PROBLEM: Record<InjectiveRecipientProblem, (prefix?: string) => string> =
  {
    penumbra: () => 'penumbra address - use shield instead',
    'other-chain': prefix => `${prefix ?? 'other'} address, not injective`,
    checksum: () => 'typo - a character is wrong',
    format: () => 'not an address',
  };

function CosmosSend({
  sourceChainId,
  initialAccountIndex,
  intent = 'send',
}: {
  sourceChainId: CosmosChainId;
  initialAccountIndex?: number;
  /** 'shield' opens straight on "into my Penumbra wallet" */
  intent?: 'send' | 'shield';
}) {
  const sourceChain = COSMOS_CHAINS[sourceChainId];
  const isEthermint = sourceChain.keyAlgo === 'eth_secp256k1';
  // two ways to move funds out of a cosmos/burner wallet: same-chain (e.g. to a
  // Noble exchange deposit address) or cross-chain via IBC (Skip routing).
  const [sendMode, setSendMode] = useState<'same' | 'ibc'>(
    intent === 'shield' && sourceChain.penumbraChannel ? 'ibc' : 'same',
  );
  const [destChainId, setDestChainId] = useState<string | undefined>(
    intent === 'shield' && sourceChain.penumbraChannel ? PENUMBRA_CHAIN_ID : undefined,
  );
  // once the user picks a destination, stop defaulting it
  const [destTouched, setDestTouched] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<CosmosAsset | undefined>();
  // The address being spent: the caller's pick, changeable among the funded
  // ones. Locked while a tx is in flight.
  const [accountIndex, setAccountIndex] = useState(initialAccountIndex ?? 0);
  const { data: deposits } = useCosmosDepositWallets(sourceChainId);
  // opened without a specific address (Send's source tab): start on the
  // address holding the most, once the scan knows
  const [autoPicked, setAutoPicked] = useState(initialAccountIndex !== undefined);
  useEffect(() => {
    if (autoPicked || !deposits) {
      return;
    }
    // by the ramp asset (USDC.inj), not raw sums: 18-decimal INJ dust would
    // otherwise outweigh real USDC
    const ramp = (w: (typeof deposits.funded)[number]) =>
      w.assets.find(x => x.denom === sourceChain.denom)?.amount ?? 0n;
    const top = [...deposits.funded].sort((a, b) =>
      ramp(a) !== ramp(b) ? (ramp(b) > ramp(a) ? 1 : -1) : b.balance > a.balance ? 1 : -1,
    )[0];
    if (top) {
      setAccountIndex(top.index);
    }
    setAutoPicked(true);
  }, [autoPicked, deposits, sourceChain.denom]);
  const [memo, setMemo] = useState('');
  const [txStatus, setTxStatus] = useState<
    'idle' | 'confirm' | 'signing' | 'broadcasting' | 'success' | 'error'
  >('idle');
  const [txHash, setTxHash] = useState<string | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [contactName, setContactName] = useState('');
  const [showContactModal, setShowContactModal] = useState(false);
  const [txPreview, setTxPreview] = useState<Record<string, unknown> | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);

  // detect wallet type
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const isZigner = selectedKeyInfo?.type === 'zigner-zafu';

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave, dismissSuggestion } = useStore(recentAddressesSelector);
  const { addContact, addAddress, findByAddress } = useStore(contactsSelector);

  const { data: skipChains = [], isLoading: chainsLoading } = useSkipChains();

  // In IBC mode default the destination to Penumbra - shielding USDC in is the
  // primary ramp (the Noble off-ramp is deprecating). Only when the source
  // chain actually has a penumbra channel (osmosis intentionally does not);
  // otherwise fall back to Osmosis, the hub most off-ramps route through.
  // Same-chain mode has no destination chain (it stays put).
  useEffect(() => {
    if (sendMode !== 'ibc') {
      setDestChainId(undefined);
      setDestTouched(false);
      return;
    }
    if (destTouched || destChainId || sourceChain.chainId === PENUMBRA_CHAIN_ID) {
      return;
    }
    // our own relayed channel: no Skip route needed
    if (sourceChain.penumbraChannel) {
      setDestChainId(PENUMBRA_CHAIN_ID);
      return;
    }
    if (sourceChain.chainId !== 'osmosis-1' && skipChains.some(c => c.chainId === 'osmosis-1')) {
      setDestChainId('osmosis-1');
    }
  }, [
    sendMode,
    skipChains,
    destChainId,
    destTouched,
    sourceChain.chainId,
    sourceChain.penumbraChannel,
  ]);
  // Penumbra is always offered when there is a direct channel, listed or not
  const destChains = useMemo(
    () =>
      sourceChain.penumbraChannel
        ? [
            { chainId: PENUMBRA_CHAIN_ID, chainName: 'Penumbra (shielded)' },
            ...skipChains.filter(c => c.chainId !== PENUMBRA_CHAIN_ID),
          ]
        : skipChains,
    [skipChains, sourceChain.penumbraChannel],
  );

  // assets hook - uses accountIndex
  const {
    data: assetsData,
    isLoading: assetsLoading,
    refetch: refetchAssets,
  } = useCosmosAssets(sourceChainId, accountIndex);

  // auto-select native asset when data loads. Must be an effect, not useMemo:
  // setState belongs in a commit-phase effect, not render. A selection this
  // address doesn't hold falls back too.
  useEffect(() => {
    const held = assetsData?.assets ?? [];
    if (!selectedAsset || !held.some(a => a.denom === selectedAsset.denom)) {
      const next = assetsData?.nativeAsset ?? held[0];
      if (next && next.denom !== selectedAsset?.denom) {
        setSelectedAsset(next);
      }
    } else {
      // keep the amount fresh for the same asset
      const fresh = held.find(a => a.denom === selectedAsset.denom);
      if (fresh && fresh.amount !== selectedAsset.amount) {
        setSelectedAsset(fresh);
      }
    }
  }, [assetsData, selectedAsset]);
  // "20" typed for one asset or address never carries over to another
  useEffect(() => {
    setAmount('');
  }, [selectedAsset?.denom, accountIndex]);

  // signing hooks
  const cosmosSend = useCosmosSend();
  const cosmosIbcTransfer = useCosmosIbcTransfer();
  const { requestAuth, PasswordModal } = usePasswordGate();

  // funded addresses (plus the current one) as "from" options
  const fromOptions = useMemo(() => {
    const funded = deposits?.funded ?? [];
    const rows = funded.some(w => w.index === accountIndex)
      ? funded
      : [...funded, ...(deposits?.all ?? []).filter(w => w.index === accountIndex)];
    return rows.map(w => ({
      index: w.index,
      address: w.address,
      summary: w.assets[0]
        ? `${w.assets[0].formatted}${w.assets.length > 1 ? ` +${w.assets.length - 1}` : ''}`
        : 'empty',
    }));
  }, [deposits, accountIndex]);
  const gas = useGasSponsor(
    sourceChainId,
    sendMode === 'same' ? 'send' : 'ibc',
    assetsData?.assets,
  );
  const payWithSponsor = !gas.gasOk && gas.sponsored;
  const canPayFee = gas.gasOk || gas.sponsored;
  // moving the gas asset itself must leave the fee behind
  const isGasAsset =
    !!selectedAsset && selectedAsset.denom.toLowerCase() === gas.gasAsset.denom.toLowerCase();
  const spendable = selectedAsset
    ? isGasAsset && !payWithSponsor
      ? selectedAsset.amount > gas.fee
        ? selectedAsset.amount - gas.fee
        : 0n
      : selectedAsset.amount
    : 0n;

  // exact, no float: round-trips through parseAmountToBaseUnits
  const handleSetMax = useCallback(() => {
    if (selectedAsset) {
      setAmount(fullDecimalString(spendable, selectedAsset.decimals));
    }
  }, [selectedAsset, spendable]);

  // Addresses rotate, so gas bought for one can land on another. When this
  // address can't pay its fee, offer to move gas over from one that can:
  // a prefilled send from there to here, then back to this address.
  const gasDenom = gas.gasAsset.denom.toLowerCase();
  const gasOf = (w: { assets: { denom: string; amount: bigint }[] }) =>
    w.assets.find(a => a.denom.toLowerCase() === gasDenom)?.amount ?? 0n;
  const gasDonors = (deposits?.funded ?? []).filter(
    // enough to pay its own send and still move something
    w => w.index !== accountIndex && gasOf(w) > gas.fee * 2n,
  );
  const [topUp, setTopUp] = useState<{ back: number; to: string }>();
  const queryClient = useQueryClient();
  const startTopUp = (donorIndex: number) => {
    if (!assetsData?.address) {
      return;
    }
    setTopUp({ back: accountIndex, to: assetsData.address });
    setSendMode('same');
    setAccountIndex(donorIndex);
    setRecipient(assetsData.address);
    setTxStatus('idle');
  };
  const finishTopUp = () => {
    if (!topUp) {
      return;
    }
    setAccountIndex(topUp.back);
    setTopUp(undefined);
    // the gas just landed there: don't show the cached pre-transfer balance
    void queryClient.invalidateQueries({ queryKey: ['cosmosAssets', sourceChainId] });
    void queryClient.invalidateQueries({ queryKey: ['cosmosDepositWallets', sourceChainId] });
    setRecipient('');
    setTxHash(undefined);
    setTxStatus('idle');
    setSendMode(intent === 'shield' && sourceChain.penumbraChannel ? 'ibc' : 'same');
  };
  // on the donor: the gas asset, all of what can move
  useEffect(() => {
    if (!topUp || assetsData?.address === topUp.to) {
      return;
    }
    const g = assetsData?.assets.find(a => a.denom.toLowerCase() === gasDenom);
    if (g && selectedAsset?.denom !== g.denom) {
      setSelectedAsset(g);
    }
  }, [topUp, assetsData, gasDenom, selectedAsset?.denom]);
  useEffect(() => {
    if (
      topUp &&
      txStatus === 'idle' &&
      selectedAsset?.denom.toLowerCase() === gasDenom &&
      amount === '' &&
      spendable > 0n
    ) {
      setAmount(fullDecimalString(spendable, selectedAsset.decimals));
    }
  }, [topUp, txStatus, selectedAsset, gasDenom, amount, spendable]);
  const [addrCopied, setAddrCopied] = useState(false);

  // convert amount to base units (integer math, no float precision loss)
  const amountInBase = useMemo(() => {
    if (!amount || isNaN(parseFloat(amount)) || !selectedAsset) {
      return '0';
    }
    return parseAmountToBaseUnits(amount, selectedAsset.decimals);
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
        : (selectedAsset?.denom ?? sourceChain.denom)
      : (selectedAsset?.denom ?? sourceChain.denom),
    amount: amountInBase,
    // Penumbra dest never goes through Skip (direct IBC below); querying it
    // asks Skip for the wrong dest denom ("upenumbra" = UM, not USDC) and
    // always returns "no routes found".
    enabled:
      !!destChainId &&
      destChainId !== PENUMBRA_CHAIN_ID &&
      parseFloat(amount) > 0 &&
      !!selectedAsset,
  });

  // auto-detect destination chain from address
  const detectedChain = useMemo(() => {
    if (!recipient) {
      return undefined;
    }
    return getChainFromAddress(recipient);
  }, [recipient]);

  // effective destination: manual selection > auto-detect > same chain
  // same-chain mode always stays on the source chain, regardless of what the
  // pasted address might auto-detect as - that is the whole point of the tab
  const effectiveDestChainId =
    sendMode === 'same'
      ? sourceChain.chainId
      : destChainId || detectedChain?.chainId || sourceChain.chainId;
  const isSameChain = effectiveDestChainId === sourceChain.chainId;
  // Shielding INTO penumbra: bypass Skip, use our own relayed channel directly.
  const isPenumbraDest = effectiveDestChainId === PENUMBRA_CHAIN_ID;

  // Injective recipients: inj1 or 0x (EIP-55), with a reason when wrong
  const ethermintRecipient =
    isEthermint && isSameChain && recipient ? parseInjectiveRecipient(recipient) : undefined;
  // the address the tx actually names (0x becomes its inj1 form)
  const toAddress = ethermintRecipient?.ok ? ethermintRecipient.address : recipient;

  // validate recipient
  const recipientValid = useMemo(() => {
    if (!recipient) {
      return false;
    }
    if (ethermintRecipient) {
      return ethermintRecipient.ok;
    }
    // penumbra addresses are bech32m and much longer than a cosmos address, so
    // isValidCosmosAddress would reject them - match the prefix directly.
    if (isPenumbraDest) {
      return recipient.startsWith('penumbra1');
    }
    if (destChainId) {
      const destPrefix = skipChains.find(c => c.chainId === destChainId)?.bech32Prefix;
      if (destPrefix) {
        return recipient.startsWith(`${destPrefix}1`);
      }
    }
    return isValidCosmosAddress(recipient);
  }, [recipient, destChainId, isPenumbraDest, skipChains, ethermintRecipient]);

  const amountBase =
    selectedAsset && /^\d+(\.\d+)?$/.test(amount.trim())
      ? BigInt(parseAmountToBaseUnits(amount.trim(), selectedAsset.decimals))
      : 0n;
  const exceeds = amountBase > spendable;
  const canSubmit =
    recipient &&
    recipientValid &&
    amountBase > 0n &&
    !exceeds &&
    canPayFee &&
    !memoLooksLikeMnemonic(memo) &&
    selectedAsset &&
    txStatus === 'idle';

  // Shielding to yourself: a fresh single-use Penumbra address of this wallet
  const { getMnemonic } = useStore(keyRingSelector);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const fillOwnPenumbra = useCallback(async () => {
    if (selectedKeyInfo?.type !== 'mnemonic') {
      return;
    }
    const mnemonic = await getMnemonic(selectedKeyInfo.id);
    if (mnemonic) {
      setRecipient(await derivePenumbraEphemeralFromMnemonic(mnemonic, penumbraAccount));
    }
  }, [selectedKeyInfo, getMnemonic, penumbraAccount]);
  const wantsOwnPenumbra = intent === 'shield' && isPenumbraDest && !recipient;
  useEffect(() => {
    if (wantsOwnPenumbra) {
      void fillOwnPenumbra().catch(() => undefined);
    }
  }, [wantsOwnPenumbra, fillOwnPenumbra]);

  // Listen for cosmos sign result from dedicated window
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes['cosmosSignResult']?.newValue) {
        const result = changes['cosmosSignResult'].newValue as { txHash: string; code: number };
        setTxStatus('success');
        setTxHash(result.txHash);
        void refetchAssets();
        void recordUsage(recipient, 'cosmos', sourceChainId);
        if (shouldSuggestSave(recipient)) {
          setShowSavePrompt(true);
        }
        // Clean up
        void chrome.storage.session.remove('cosmosSignResult');
      }
    };
    chrome.storage.session.onChanged.addListener(listener);
    return () => chrome.storage.session.onChanged.removeListener(listener);
  }, [refetchAssets, recordUsage, recipient, sourceChainId, shouldSuggestSave]);

  // show confirmation screen with tx preview
  const handleReview = useCallback(() => {
    if (!canSubmit || !selectedAsset) {
      return;
    }
    setTxError(undefined);
    setShowRawJson(false);

    // build preview of what will be signed
    const amtBase = parseAmountToBaseUnits(amount, selectedAsset.decimals);
    const denom = selectedAsset.denom;

    if (isSameChain) {
      setTxPreview({
        type: 'cosmos-sdk/MsgSend',
        chain_id: sourceChain.chainId,
        from: assetsData?.address ?? '...',
        to: toAddress,
        amount: [{ denom, amount: String(amtBase) }],
        gas: gas.gasLimit,
      });
    } else {
      // penumbra shield-in uses our direct relayed channel; everything else
      // takes the channel Skip resolved.
      const channel = isPenumbraDest
        ? sourceChain.penumbraChannel
        : route?.operations.find(op => op.transfer)?.transfer?.channel;
      setTxPreview({
        type: 'cosmos-sdk/MsgTransfer',
        chain_id: sourceChain.chainId,
        from: assetsData?.address ?? '...',
        to: recipient,
        token: { denom, amount: String(amtBase) },
        source_channel: channel ?? 'unknown',
        gas: gas.gasLimit,
      });
    }

    setTxStatus('confirm');
  }, [
    canSubmit,
    selectedAsset,
    amount,
    sourceChainId,
    sourceChain,
    isSameChain,
    isPenumbraDest,
    recipient,
    assetsData,
    route,
    gas.gasLimit,
  ]);

  // confirmed — ask password then sign+broadcast
  const handleConfirm = useCallback(async () => {
    if (!selectedAsset) {
      return;
    }

    const authorized = await requestAuth();
    if (!authorized) {
      setTxStatus('confirm');
      return;
    }

    setTxStatus('signing');
    setTxError(undefined);

    try {
      const sym = selectedAsset.symbol;
      // Tracked on home (any result with a txHash); a zigner QR hand-off
      // broadcasts nothing here, so trackTx drops its record.
      const tracked = <T extends CosmosTxResult | CosmosZignerSignResult>(
        label: string,
        run: () => Promise<T>,
      ) =>
        trackTx(
          { network: sourceChainId === 'injective' ? 'injective' : 'cosmos', label },
          async () => {
            const r = await run();
            return {
              r,
              txId: 'txHash' in r ? r.txHash : undefined,
              restUrl: 'restUrl' in r ? r.restUrl : undefined,
            };
          },
        ).then(x => x.r);
      const signing = {
        decimals: selectedAsset.decimals,
        expectedAddress: assetsData?.address,
        sponsored: payWithSponsor,
      };
      let result;

      if (isSameChain) {
        result = await tracked(`send ${amount} ${sym}`, () =>
          cosmosSend.mutateAsync({
            chainId: sourceChainId,
            toAddress,
            amount,
            denom: selectedAsset.denom,
            memo: memo.trim() || undefined,
            accountIndex,
            ...signing,
          }),
        );
      } else {
        // penumbra shield-in: direct single-hop MsgTransfer over our relayed
        // channel (verified STATE_OPEN, client Active). Skip is bypassed.
        const channel = isPenumbraDest
          ? sourceChain.penumbraChannel
          : route?.operations.find(op => op.transfer)?.transfer?.channel;
        if (!channel) {
          throw new Error(
            isPenumbraDest
              ? `no penumbra channel configured for ${sourceChain.name}`
              : 'no ibc route found',
          );
        }

        result = await tracked(
          isPenumbraDest ? `shield ${amount} ${sym}` : `send ${amount} ${sym}`,
          () =>
            cosmosIbcTransfer.mutateAsync({
              sourceChainId,
              destChainId: effectiveDestChainId,
              sourceChannel: channel,
              toAddress: recipient,
              amount,
              denom: selectedAsset.denom,
              memo: memo.trim() || undefined,
              accountIndex,
              ...signing,
            }),
        );
      }

      // check if this is a zigner sign request (needs QR flow in dedicated window)
      if (result.type === 'zigner') {
        const serializable = {
          ...result,
          pubkey: Array.from(result.pubkey),
          signRequest: {
            ...result.signRequest,
            signDocBytes: Array.from(result.signRequest.signDocBytes),
          },
        };
        await chrome.storage.session.set({ cosmosSignData: serializable });
        await openInDedicatedWindow(PopupPath.COSMOS_SIGN, { width: 400, height: 628 });
        setTxStatus('idle');
        return;
      }

      setTxStatus('success');
      setTxHash(result.txHash);
      void refetchAssets();
      if (!isPenumbraDest) {
        void recordUsage(toAddress, 'cosmos', sourceChainId);
        if (shouldSuggestSave(toAddress)) {
          setShowSavePrompt(true);
        }
      }
    } catch (err) {
      setTxStatus('error');
      setTxError(err instanceof Error ? err.message : 'transaction failed');
    }
  }, [
    isSameChain,
    isPenumbraDest,
    sourceChain,
    sourceChainId,
    effectiveDestChainId,
    recipient,
    toAddress,
    amount,
    selectedAsset,
    accountIndex,
    route,
    assetsData,
    payWithSponsor,
    isEthermint,
    cosmosSend,
    cosmosIbcTransfer,
    refetchAssets,
    recordUsage,
    shouldSuggestSave,
    requestAuth,
  ]);

  return (
    <div className='flex flex-col gap-4'>
      {PasswordModal}

      {/* two ways out: same-chain (Noble) or cross-chain (IBC) */}
      <div className='flex rounded-lg bg-elev-2 p-1'>
        <button
          type='button'
          onClick={() => setSendMode('same')}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
            sendMode === 'same'
              ? 'bg-canvas text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg-high',
          )}
        >
          send in {sourceChain.name}
        </button>
        <button
          type='button'
          onClick={() => setSendMode('ibc')}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
            sendMode === 'ibc' ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high',
          )}
        >
          send to ibc
        </button>
      </div>

      {/* the address being spent; any funded one can be picked */}
      {assetsData?.address && (
        <div>
          <label className='mb-1 block text-xs text-fg-muted'>from</label>
          {fromOptions.length > 1 ? (
            <select
              value={accountIndex}
              onChange={e => setAccountIndex(Number(e.target.value))}
              disabled={txStatus !== 'idle'}
              aria-label='from address'
              className='w-full border border-border-soft bg-input px-3 py-2.5 font-mono text-sm text-fg focus:border-zigner-gold focus:outline-none'
            >
              {fromOptions.map(w => (
                <option key={w.index} value={w.index}>
                  #{w.index} {shortAddress(w.address)} - {w.summary}
                </option>
              ))}
            </select>
          ) : (
            <span className='block border border-border-soft bg-input px-3 py-2.5 font-mono text-sm text-fg-muted'>
              {shortAddress(assetsData.address)}
            </span>
          )}
        </div>
      )}

      {/* Logical order for someone who doesn't have an address ready: pick the
          chain, then the asset, then where it goes, then how much. Auto-detect
          still fills the chain if they paste an address first. */}

      {/* destination chain - IBC mode only; same-chain stays on the source */}
      {sendMode === 'ibc' && (
        <div>
          <label className='mb-1 block text-xs text-fg-muted'>destination chain</label>
          {chainsLoading && !sourceChain.penumbraChannel ? (
            <div className='h-10 rounded-lg bg-elev-2 animate-pulse' />
          ) : (
            <CosmosChainSelector
              chains={destChains}
              selected={destChainId ?? detectedChain?.chainId}
              onSelect={id => {
                setDestTouched(true);
                setDestChainId(id || undefined);
                setRecipient('');
              }}
              currentChainId={sourceChain.chainId}
              autoLabel={
                destChainId
                  ? undefined
                  : detectedChain
                    ? `auto (${detectedChain.name})`
                    : 'auto-detect from address'
              }
            />
          )}
          {/* alternative: hand the cross-chain routing off to Skip's own UI */}
          <button
            type='button'
            onClick={() => void chrome.tabs.create({ url: 'https://go.skip.build/' })}
            className='mt-1.5 flex items-center gap-1 text-label text-network-accent transition-colors hover:text-fg-high'
          >
            <span className='i-ph-arrow-square-out h-3 w-3' />
            or route via Skip (go.skip.build)
          </button>
        </div>
      )}

      {/* asset selector */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>asset</label>
        <AssetSelector
          assets={assetsData?.assets ?? []}
          selected={selectedAsset}
          onSelect={setSelectedAsset}
          loading={assetsLoading}
        />
      </div>

      {/* recipient / destination address */}
      <div>
        <label className='mb-1 block text-xs text-fg-muted'>destination address</label>
        <input
          type='text'
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          placeholder={
            sendMode === 'same' ? `${sourceChain.bech32Prefix}1...` : 'destination address'
          }
          className={cn(
            'w-full rounded-lg border bg-input px-3 py-2.5 text-sm text-fg',
            'placeholder:text-fg-muted transition-colors duration-100',
            'focus:border-penumbra-purple focus:outline-none',
            recipient && !recipientValid ? 'border-red-400' : 'border-border-soft',
          )}
        />
        {isPenumbraDest && selectedKeyInfo?.type === 'mnemonic' && (
          <button
            type='button'
            onClick={() => void fillOwnPenumbra()}
            className='mt-1 text-xs text-zigner-gold hover:underline'
          >
            my penumbra wallet
          </button>
        )}
        {recipient && !recipientValid && (
          <p className='mt-1 text-xs text-red-400'>
            {ethermintRecipient && !ethermintRecipient.ok
              ? ETHERMINT_RECIPIENT_PROBLEM[ethermintRecipient.problem](ethermintRecipient.prefix)
              : isPenumbraDest
                ? 'invalid penumbra address'
                : 'invalid cosmos address'}
          </p>
        )}
        {ethermintRecipient?.ok && ethermintRecipient.fromHex && (
          <p className='mt-1 font-mono text-xs text-fg-muted' title={toAddress}>
            sends to {shortAddress(toAddress)}
          </p>
        )}
        {sendMode === 'ibc' && detectedChain && !destChainId && (
          <p className='mt-1 text-xs text-fg-muted'>detected: {detectedChain.name}</p>
        )}
        {sendMode === 'same' && !recipient && (deposits?.funded.length ?? 0) > 1 && (
          <div className='mt-1 flex flex-wrap gap-1'>
            {(deposits?.funded ?? [])
              .filter(w => w.index !== accountIndex)
              .slice(0, 4)
              .map(w => (
                <button
                  key={w.index}
                  type='button'
                  onClick={() => setRecipient(w.address)}
                  title={w.address}
                  className='border border-border-soft px-2 py-1 font-mono text-label text-fg-muted hover:bg-elev-1 hover:text-fg-high'
                >
                  my #{w.index}
                </button>
              ))}
          </div>
        )}
        <RecipientPicker network='cosmos' onSelect={setRecipient} show={!recipient} />
      </div>

      {/* amount */}
      <div>
        <div className='mb-1 flex items-center justify-between'>
          <label className='text-xs text-fg-muted'>
            amount {selectedAsset ? `(${selectedAsset.symbol})` : ''}
          </label>
          {selectedAsset && (
            <span className='text-xs text-fg-muted'>
              balance: <Sensitive>{selectedAsset.formatted}</Sensitive>
            </span>
          )}
        </div>
        <div className='relative'>
          <input
            type='text'
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder='0.00'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 pr-14 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
          />
          {selectedAsset && spendable > 0n && (
            <button
              type='button'
              onClick={handleSetMax}
              className='absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-elev-2 px-2 py-0.5 text-xs text-fg-muted transition-colors hover:bg-elev-1/80 hover:text-fg-high'
            >
              max
            </button>
          )}
        </div>
      </div>

      {exceeds && <p className='-mt-2 text-xs text-amber-400/90'>more than this address holds</p>}
      <p className='-mt-2 text-xs text-fg-muted'>
        {payWithSponsor
          ? 'fee covered by the rotko sponsor'
          : `fee ~${formatBaseUnits(gas.fee, gas.gasAsset.decimals, 6)} ${gas.gasAsset.symbol}`}
        {!canPayFee && <span className='text-amber-400/90'> - none on this address</span>}
      </p>
      {!canPayFee && !topUp && assetsData?.address && (
        <div className='-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs'>
          {gasDonors.slice(0, 2).map(w => (
            <button
              key={w.index}
              type='button'
              onClick={() => startTopUp(w.index)}
              className='text-zigner-gold hover:underline'
            >
              move {gas.gasAsset.symbol} here from #{w.index} (
              {formatBaseUnits(gasOf(w), gas.gasAsset.decimals, 4)})
            </button>
          ))}
          <button
            type='button'
            onClick={() => {
              void navigator.clipboard.writeText(assetsData.address);
              setAddrCopied(true);
              setTimeout(() => setAddrCopied(false), 1500);
            }}
            className='text-fg-muted hover:text-fg-high'
            title={`send ${gas.gasAsset.symbol} to ${assetsData.address}`}
          >
            {addrCopied ? 'copied' : `copy this address to top up`}
          </button>
        </div>
      )}
      {topUp && (
        <div className='-mt-2 flex items-center justify-between gap-2 border border-border-soft px-3 py-2 text-xs'>
          <span className='text-fg-muted'>
            moving {gas.gasAsset.symbol} to {shortAddress(topUp.to)} for gas
          </span>
          <button
            type='button'
            onClick={finishTopUp}
            className={
              txStatus === 'success'
                ? 'text-zigner-gold hover:underline'
                : 'text-fg-muted hover:text-fg-high'
            }
          >
            {txStatus === 'success' ? 'continue on that address' : 'cancel'}
          </button>
        </div>
      )}

      {/* memo: exchanges often credit a deposit only with it. Penumbra can't
          carry one, so this is the only place it can be set. */}
      {!isPenumbraDest && (
        <div>
          <label htmlFor='cosmos-send-memo' className='mb-1 block text-xs text-fg-muted'>
            memo (optional)
          </label>
          <input
            id='cosmos-send-memo'
            type='text'
            value={memo}
            onChange={e => setMemo(e.target.value)}
            placeholder='if the exchange needs one'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
          />
          {memoLooksLikeMnemonic(memo) && (
            <p className='mt-1 text-xs text-red-400'>
              that looks like a recovery phrase - never put it in a memo
            </p>
          )}
        </div>
      )}

      {/* route info */}
      {routeLoading && (
        <div className='flex items-center gap-2 text-xs text-fg-muted'>
          <span className='i-ph-arrows-clockwise h-3 w-3 animate-spin' />
          finding route...
        </div>
      )}
      {route && (
        <div className='rounded-lg border border-border-soft bg-elev-2/20 p-3'>
          <div className='flex items-center justify-between text-xs'>
            <span className='text-fg-muted'>receive</span>
            <span className='font-mono'>
              <Sensitive>{(parseFloat(route.amountOut) / Math.pow(10, 6)).toFixed(6)}</Sensitive>
            </span>
          </div>
          {route.doesSwap && route.swapVenue && (
            <div className='mt-1 flex items-center justify-between text-xs'>
              <span className='text-fg-muted'>via</span>
              <span>{route.swapVenue.name}</span>
            </div>
          )}
          {route.txsRequired > 1 && (
            <div className='mt-1 flex items-center justify-between text-xs'>
              <span className='text-fg-muted'>transactions</span>
              <span>{route.txsRequired}</span>
            </div>
          )}
        </div>
      )}
      {routeError && !isPenumbraDest && (
        <p className='text-xs text-red-400'>{routeError.message}</p>
      )}
      {sendMode === 'ibc' && isPenumbraDest && (
        <p className='flex items-center gap-1.5 text-xs text-fg-muted'>
          <span className='i-ph-shield h-3.5 w-3.5 shrink-0 text-zigner-gold' />
          arrives shielded
        </p>
      )}

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/40 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-fg-muted mt-1 font-mono break-all'>{txHash}</p>
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
        <div className='rounded-lg border border-border-soft bg-canvas p-3'>
          <p className='text-sm font-medium mb-2'>name this contact</p>
          <input
            type='text'
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            placeholder='enter name...'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm mb-2 focus:border-penumbra-purple focus:outline-none'
            autoFocus
          />
          <div className='flex gap-2'>
            <button
              onClick={async () => {
                if (contactName.trim()) {
                  const newContact = await addContact({ name: contactName.trim() });
                  await addAddress(newContact.id, {
                    network: 'cosmos',
                    address: recipient,
                    chainId: sourceChainId,
                  });
                  setShowContactModal(false);
                  setContactName('');
                }
              }}
              disabled={!contactName.trim()}
              className='flex-1 rounded-md bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-gold-foreground transition-colors disabled:opacity-50'
            >
              save
            </button>
            <button
              onClick={() => {
                setShowContactModal(false);
                setContactName('');
              }}
              className='flex-1 rounded-md bg-elev-2 px-3 py-1.5 text-xs text-fg-muted transition-colors'
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* confirmation summary */}
      {txStatus === 'confirm' && selectedAsset && (
        <div className='rounded-md border border-zigner-gold/30 bg-elev-1 p-3'>
          <p className='kicker mb-2'>confirm transaction</p>
          <div className='flex flex-col gap-1.5 text-xs'>
            <div className='flex justify-between'>
              <span className='text-fg-dim lowercase'>type</span>
              <span className='text-fg-high'>{isSameChain ? 'send' : 'ibc transfer'}</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-fg-dim lowercase'>chain</span>
              <span className='text-fg-high'>{sourceChain.name}</span>
            </div>
            <div className='flex justify-between gap-2'>
              <span className='text-fg-dim lowercase shrink-0'>to</span>
              <span className='tabular text-right break-all text-fg-high'>{recipient}</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-fg-dim lowercase'>amount</span>
              <span className='tabular text-zigner-gold'>
                <Sensitive>
                  {amount} {selectedAsset.symbol}
                </Sensitive>
              </span>
            </div>
            {!isSameChain && effectiveDestChainId && (
              <div className='flex justify-between'>
                <span className='text-fg-dim lowercase'>destination</span>
                <span className='text-fg-high'>
                  {skipChains.find(c => c.chainId === effectiveDestChainId)?.chainName ??
                    effectiveDestChainId}
                </span>
              </div>
            )}
          </div>

          {/* raw tx json toggle */}
          {txPreview && (
            <div className='mt-2'>
              <button
                onClick={() => setShowRawJson(!showRawJson)}
                className='text-label text-fg-dim hover:text-fg-high transition-colors lowercase'
              >
                {showRawJson ? 'hide' : 'view'} raw transaction json
              </button>
              {showRawJson && (
                <pre className='mt-2 max-h-48 overflow-auto rounded-sm bg-canvas p-2 text-label tabular text-fg-muted leading-relaxed'>
                  {JSON.stringify(txPreview, null, 2)}
                </pre>
              )}
            </div>
          )}

          <div className='flex gap-2 mt-3'>
            <Button variant='gradient' onClick={() => void handleConfirm()} className='flex-1'>
              confirm & sign
            </Button>
            <Button variant='secondary' onClick={() => setTxStatus('idle')} className='flex-1'>
              back
            </Button>
          </div>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/40 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-fg-muted mt-1'>{txError}</p>
        </div>
      )}

      {/* submit */}
      <Button
        variant='gradient'
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
            handleReview();
          }
        }}
        disabled={
          (txStatus === 'idle' && !canSubmit) ||
          txStatus === 'confirm' ||
          txStatus === 'signing' ||
          txStatus === 'broadcasting'
        }
        className={cn('mt-2 w-full', txStatus === 'confirm' && 'hidden')}
      >
        {txStatus === 'signing' && 'building transaction...'}
        {txStatus === 'broadcasting' && 'broadcasting...'}
        {txStatus === 'idle' && (routeLoading ? 'finding route...' : 'review')}
        {txStatus === 'success' && 'send another'}
        {txStatus === 'error' && 'retry'}
      </Button>

      {txStatus !== 'confirm' && isZigner && (
        <p className='text-center text-xs text-fg-muted'>sign with zafu zigner</p>
      )}
    </div>
  );
}

type PenumbraMode = 'send' | 'ibc';

/** Combined Penumbra send with tabs */
function PenumbraSend({
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
      <div className='flex rounded-lg bg-elev-2 p-1'>
        <button
          onClick={() => setMode('send')}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
            mode === 'send' ? 'bg-canvas text-fg shadow-sm' : 'text-fg-muted hover:text-fg-high',
          )}
        >
          send
        </button>
        <button
          onClick={() => setMode('ibc')}
          className={cn(
            'flex-1 rounded-md py-2 text-sm font-medium transition-colors',
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
    // No change note is created either way — no dust left behind.
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
            className='flex w-full items-center justify-between rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50 disabled:opacity-50'
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
            <div className='absolute top-full left-0 right-0 z-50 mt-1 rounded-lg border border-border-soft bg-canvas shadow-lg'>
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
              'flex-1 rounded-lg border bg-input px-3 py-2.5 text-sm text-fg',
              'placeholder:text-fg-muted transition-colors duration-100',
              'focus:border-penumbra-purple focus:outline-none disabled:opacity-50',
              sendState.recipient && !addressValid ? 'border-red-400' : 'border-border-soft',
            )}
          />
          <button
            type='button'
            onClick={() => setShowQrScanner(true)}
            disabled={txStatus !== 'idle'}
            className='shrink-0 flex h-[42px] w-[42px] items-center justify-center rounded-lg border border-border-soft bg-input text-fg-muted hover:text-fg-high transition-colors disabled:opacity-50'
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
          className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none disabled:opacity-50'
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
          className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none disabled:opacity-50'
        />
      </div>

      {/* transaction status */}
      {txStatus === 'success' && txHash && (
        <div className='rounded-lg border border-green-500/40 bg-green-500/10 p-3'>
          <p className='text-sm text-green-400'>transaction sent!</p>
          <p className='text-xs text-fg-muted mt-1 font-mono break-all'>{txHash}</p>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/40 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-fg-muted mt-1'>{txError}</p>
        </div>
      )}

      {/* submit */}
      <Button
        variant='gradient'
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

function PenumbraIbcSend({ onSuccess }: { onSuccess?: () => void }) {
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
          <div className='h-10 rounded-lg bg-elev-2 animate-pulse' />
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
          <div className='rounded-lg border border-border-soft bg-input px-3 py-2.5'>
            <div className='flex items-center justify-between gap-2'>
              <span className='text-label text-fg-muted lowercase'>your deposit address</span>
              <span className='rounded bg-red-500/10 px-1.5 py-0.5 text-label leading-none text-red-400 lowercase'>
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
                'w-full rounded-lg border bg-input px-3 py-2.5 text-sm text-fg',
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
                className='flex w-full items-center gap-1.5 rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg text-left disabled:opacity-50'
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
                <div className='absolute z-10 mt-1 w-full rounded-lg border border-border-soft bg-canvas shadow-lg max-h-48 overflow-y-auto'>
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
          className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none disabled:opacity-50'
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
        <div className='rounded-lg border border-green-500/40 bg-green-500/10 p-3'>
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
        <div className='rounded-lg border border-border-soft bg-canvas p-3'>
          <p className='text-sm font-medium mb-2'>name this contact</p>
          <input
            type='text'
            value={contactName}
            onChange={e => setContactName(e.target.value)}
            placeholder='enter name...'
            className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm mb-2 focus:border-penumbra-purple focus:outline-none'
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
              className='flex-1 rounded-md bg-zigner-gold px-3 py-1.5 text-xs font-medium text-zigner-gold-foreground transition-colors disabled:opacity-50'
            >
              save
            </button>
            <button
              onClick={() => {
                setShowContactModal(false);
                setContactName('');
              }}
              className='flex-1 rounded-md bg-elev-2 px-3 py-1.5 text-xs text-fg-muted transition-colors'
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <div className='rounded-lg border border-red-500/40 bg-red-500/10 p-3'>
          <p className='text-sm text-red-400'>transaction failed</p>
          <p className='text-xs text-fg-muted mt-1'>{txError}</p>
        </div>
      )}

      {/* submit */}
      <Button
        variant='gradient'
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

// Noble only for now - Cosmos Hub has no live channel to Penumbra, so shielding
// from it doesn't work. Re-add when its channel/client is configured.
const COSMOS_CHAIN_IDS: CosmosChainId[] = ['noble'];

/** location state for prefilling forms from inbox */
interface SendLocationState {
  prefillMemo?: string;
  prefillRecipient?: string;
  prefillAmount?: string;
  /**
   * Row-level "Send X" quick-action on the home asset list: base denom of the
   * asset to preselect. Matched against `metadata.base` on the fetched balance
   * list. Falls back to the top-priority balance if the denom is not found.
   */
  prefillAsset?: string;
  /**
   * Cosmos off-ramp: open the cosmos send for this chain WITHOUT switching the
   * active network. Noble is a burner doorway, not a network - the user stays
   * on Penumbra; this just routes the send form to the transparent chain.
   */
  cosmosChain?: CosmosChainId;
  /** which burner index (BIP44 address_index) to spend from. Default 0. */
  cosmosAccountIndex?: number;
  /**
   * Why the cosmos send form was opened: 'shield' (back into Penumbra) or
   * 'send' (out to an external address, e.g. an exchange). The form is the same
   * today; this lets it prefill/route differently later without changing callers.
   */
  cosmosIntent?: 'send' | 'shield';
}

export function SendPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeNetwork = useStore(selectActiveNetwork);
  // dedicated window should close on completion, side panel navigates normally
  const [inDedicatedWindow] = useState(() => isDedicatedWindow());

  // get prefill from location state (inbox compose), URL params (external message), or hash params
  const locationState = location.state as SendLocationState | undefined;
  const searchParams = new URLSearchParams(location.search);
  // `[primary]` expands to the user's oldest non-multisig Zcash wallet (the original onboarding
  // wallet — new wallets are prepended, so the oldest sits at the END of the array). `[self]`
  // is kept as an alias for backward compatibility. Letting callers reference the address by
  // token saves a "what's my address" round-trip; the user can still edit the memo before send.
  const allZcashWallets = useStore(s => s.wallets.zcashWallets);
  const primaryAddr = allZcashWallets.filter(w => !w.multisig).at(-1)?.address;
  const rawMemo = searchParams.get('memo');
  const memoHasToken = !!rawMemo && (rawMemo.includes('[primary]') || rawMemo.includes('[self]'));
  // wallets persist asynchronously; if a token is in the memo but the store hasn't hydrated yet,
  // we show a brief loading state instead of leaking the literal token into the form.
  const waitingForWallets = memoHasToken && !primaryAddr && allZcashWallets.length === 0;
  const externalMemo = (() => {
    if (!rawMemo) {
      return undefined;
    }
    if (!memoHasToken) {
      return rawMemo;
    }
    if (!primaryAddr) {
      return rawMemo;
    }
    return rawMemo.replaceAll('[primary]', primaryAddr).replaceAll('[self]', primaryAddr);
  })();
  const prefill = locationState?.prefillRecipient
    ? {
        recipient: locationState.prefillRecipient,
        amount: locationState.prefillAmount,
        memo: locationState.prefillMemo,
      }
    : searchParams.get('to')
      ? {
          recipient: searchParams.get('to') ?? undefined,
          // amount_zat (uint64 string, zatoshi) is the unambiguous unit for external callers;
          // ZcashSend expects a decimal ZEC string so we convert (1 ZEC = 1e8 zat).
          amount: (() => {
            const zat = searchParams.get('amount_zat');
            if (!zat) {
              return undefined;
            }
            const n = Number(zat);
            if (!Number.isFinite(n) || n <= 0) {
              return undefined;
            }
            return (n / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
          })(),
          memo: externalMemo,
        }
      : undefined;

  const goBack = () => (inDedicatedWindow ? window.close() : navigate(PopupPath.INDEX));
  // cosmos chain from route state (burner off-ramp) takes precedence over the
  // active network - the user is on Penumbra, just routing a send to Noble.
  // On Penumbra, Send can also spend from a transparent chain (Injective, ...):
  // same form as the home rows' send/shield buttons open.
  const [pickedSource, setPickedSource] = useState<CosmosChainId>();
  const sourceChoices =
    activeNetwork === 'penumbra' && !locationState?.cosmosChain
      ? (getActiveIbcSubnetworks('penumbra') as CosmosChainId[])
      : [];
  const cosmosChain = locationState?.cosmosChain ?? pickedSource;
  const isCosmos = cosmosChain != null || COSMOS_CHAIN_IDS.includes(activeNetwork as CosmosChainId);
  const isPenumbra = !cosmosChain && activeNetwork === 'penumbra';
  const isZcash = !cosmosChain && activeNetwork === 'zcash';

  const getTitle = () => {
    if (isPenumbra) {
      return 'send penumbra';
    }
    if (isCosmos) {
      // the burner "shield" and "send" buttons route here with an intent; name
      // the screen for what the user set out to do so they are not identical
      return locationState?.cosmosIntent === 'shield' ? 'shield into penumbra' : 'send';
    }
    if (isZcash) {
      return 'send zcash';
    }
    return `send ${activeNetwork}`;
  };

  // zcash uses full-screen flow
  if (isZcash) {
    if (waitingForWallets) {
      return (
        <div className='flex h-full items-center justify-center p-6 text-xs text-fg-muted'>
          loading wallets…
        </div>
      );
    }
    return <ZcashSend onClose={goBack} accountIndex={0} mainnet={true} prefill={prefill} />;
  }

  return (
    <div className='flex flex-col'>
      {/* Header */}
      <div className='flex items-center gap-3 border-b border-border-soft px-4 py-3'>
        {!inDedicatedWindow && (
          <button onClick={goBack} className='text-fg-muted transition-colors hover:text-fg-high'>
            <span className='i-ph-arrow-left h-5 w-5' />
          </button>
        )}
        <h1 className='text-lg font-medium text-fg'>{getTitle()}</h1>
      </div>

      {/* Content */}
      <div className='p-4'>
        {sourceChoices.length > 0 && (
          <div className='mb-4 flex gap-1 border border-border-soft p-1' role='tablist'>
            {([undefined, ...sourceChoices] as const).map(c => (
              <button
                key={c ?? 'shielded'}
                type='button'
                role='tab'
                aria-selected={pickedSource === c}
                onClick={() => setPickedSource(c)}
                className={cn(
                  'flex-1 py-1.5 text-xs lowercase transition-colors',
                  pickedSource === c
                    ? 'bg-elev-2 text-fg-high'
                    : 'text-fg-muted hover:text-fg-high',
                )}
              >
                {c ? COSMOS_CHAINS[c].name : 'shielded'}
              </button>
            ))}
          </div>
        )}
        {isPenumbra ? (
          <PenumbraSend
            onSuccess={inDedicatedWindow ? () => window.close() : undefined}
            prefillAsset={locationState?.prefillAsset}
          />
        ) : isCosmos ? (
          isActiveIbcChain((cosmosChain ?? activeNetwork) as NetworkType) ? (
            <CosmosSend
              key={cosmosChain ?? activeNetwork}
              sourceChainId={(cosmosChain ?? activeNetwork) as CosmosChainId}
              initialAccountIndex={locationState?.cosmosAccountIndex}
              intent={locationState?.cosmosIntent ?? 'send'}
            />
          ) : (
            // No live IBC channel to this chain right now (channels close on
            // network upgrades and reopen later), so deposit/send is unavailable.
            <div className='flex flex-col gap-2 rounded-lg border border-border-soft bg-elev-1 p-4 text-sm'>
              <span className='font-medium text-fg'>channel unavailable</span>
              <span className='text-fg-muted'>
                {getNetwork((cosmosChain ?? activeNetwork) as NetworkType).name} has no open IBC
                channel with Penumbra right now. Only Noble is available until other channels are
                reopened.
              </span>
            </div>
          )
        ) : (
          <div className='flex flex-col gap-4'>
            <div>
              <label className='mb-1 block text-xs text-fg-muted'>recipient</label>
              <input
                type='text'
                placeholder='enter address'
                className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
              />
            </div>

            <div>
              <label className='mb-1 block text-xs text-fg-muted'>amount</label>
              <input
                type='text'
                placeholder='0.00'
                className='w-full rounded-lg border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
              />
            </div>

            <Button variant='gradient' className='mt-4 w-full'>
              continue
            </Button>

            <p className='text-center text-xs text-fg-muted'>
              {activeNetwork === 'polkadot' && 'light client transaction'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default SendPage;
