/**
 * cosmos chain send form (skip-routed transparent sends)
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Sensitive } from '../../../components/sensitive';
import { PopupPath } from '../paths';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from '../../../state';
import { cosmosKeyFor } from '../../../signing/cosmos-key';
import { selectPenumbraAccount } from '../../../state/keyring';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
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
import {
  COSMOS_CHAINS,
  type CosmosChainId,
  isValidCosmosAddress,
  getChainFromAddress,
} from '@repo/wallet/networks/cosmos/chains';
import { cn } from '@repo/ui/lib/utils';
import { Button } from '@repo/ui/components/ui/button';
import { usePasswordGate } from '../../../hooks/password-gate';
import { openInDedicatedWindow } from '../../../utils/navigate';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { useGasSponsor } from '../../../transparent/sponsor';
import { formatBaseUnits, fullDecimalString } from '../../../transparent/assets';
import { routeForChain, usePenumbraRoutes } from '../../../transparent/penumbra-routes';
import { shortAddress } from '../../../transparent/hd';
import {
  parseInjectiveRecipient,
  type InjectiveRecipientProblem,
} from '@repo/wallet/networks/injective/derive';
import { derivePenumbraEphemeralFromMnemonic } from '../../../hooks/use-address';
import { RecipientPicker } from '../../../components/recipient-picker';

import { SaveContactPrompt } from './shared';
import { RegistryIcon } from '../../../shared/components/registry-icon';

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
    return <div className='h-10 bg-elev-2 animate-pulse' />;
  }

  if (assets.length === 0) {
    return (
      <div className='border border-border-soft bg-input px-3 py-2.5 text-sm text-fg-muted'>
        no assets
      </div>
    );
  }

  return (
    <div className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className='flex w-full items-center justify-between border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        {selected ? (
          <div className='flex items-center gap-2'>
            <span>{selected.symbol}</span>
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
        <div className='absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto border border-border-soft bg-canvas shadow-lg'>
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
              <span>{asset.symbol}</span>
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
        className='flex w-full items-center justify-between border border-border-soft bg-input px-3 py-2.5 text-sm transition-colors hover:border-zigner-gold/50'
      >
        <span className={!manuallySelected && !selected ? 'text-fg-muted' : ''}>{displayName}</span>
        <span
          className={cn('i-ph-caret-down h-4 w-4 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className='absolute top-full left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto border border-border-soft bg-canvas shadow-lg'>
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
              <RegistryIcon
                name={chain.chainName}
                images={chain.logoUri ? [{ png: chain.logoUri }] : undefined}
                className='h-5 w-5'
                size={20}
              />
              <span>{chain.chainName}</span>
            </button>
          ))}
        </div>
      )}
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
 * Keplr guards the specific slip people actually make - pasting a seed
 * phrase in - by rejecting a memo that is mostly BIP-39 words. Same rule
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

export function CosmosSend({
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
  // the live chain -> penumbra channel (discovered, never an expired pin);
  // undefined when the chain has no route into penumbra right now
  const penumbraChannel = routeForChain(sourceChainId, usePenumbraRoutes())?.penumbraChannel;
  const isEthermint = sourceChain.keyAlgo === 'eth_secp256k1';
  // two ways to move funds out of a cosmos/burner wallet: same-chain (e.g. to a
  // Noble exchange deposit address) or cross-chain via IBC (Skip routing).
  // a shield has exactly one destination (penumbra over IBC), so the mode and
  // destination-chain pickers don't apply to it
  const isShield = intent === 'shield' && !!penumbraChannel;
  const [sendMode, setSendMode] = useState<'same' | 'ibc'>(isShield ? 'ibc' : 'same');
  const [destChainId, setDestChainId] = useState<string | undefined>(
    isShield ? PENUMBRA_CHAIN_ID : undefined,
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
  const isZigner = cosmosKeyFor(selectedKeyInfo, sourceChainId)?.signer === 'zigner';

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
    if (penumbraChannel) {
      setDestChainId(PENUMBRA_CHAIN_ID);
      return;
    }
    if (sourceChain.chainId !== 'osmosis-1' && skipChains.some(c => c.chainId === 'osmosis-1')) {
      setDestChainId('osmosis-1');
    }
  }, [sendMode, skipChains, destChainId, destTouched, sourceChain.chainId, penumbraChannel]);
  // Penumbra is always offered when there is a direct channel, listed or not
  const destChains = useMemo(
    () =>
      penumbraChannel
        ? [
            { chainId: PENUMBRA_CHAIN_ID, chainName: 'Penumbra (shielded)' },
            ...skipChains.filter(c => c.chainId !== PENUMBRA_CHAIN_ID),
          ]
        : skipChains,
    [skipChains, penumbraChannel],
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
    setSendMode(intent === 'shield' && penumbraChannel ? 'ibc' : 'same');
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
        ? penumbraChannel
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

  // confirmed - ask password then sign+broadcast
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
          ? penumbraChannel
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
      {!isShield && (
        <div className='flex border border-border-soft p-1'>
          <button
            type='button'
            onClick={() => setSendMode('same')}
            className={cn(
              'flex-1 py-1.5 text-xs lowercase transition-colors',
              sendMode === 'same' ? 'bg-elev-2 text-fg-high' : 'text-fg-muted hover:text-fg-high',
            )}
          >
            within {sourceChain.name}
          </button>
          <button
            type='button'
            onClick={() => setSendMode('ibc')}
            className={cn(
              'flex-1 py-1.5 text-xs lowercase transition-colors',
              sendMode === 'ibc' ? 'bg-elev-2 text-fg-high' : 'text-fg-muted hover:text-fg-high',
            )}
          >
            to another chain
          </button>
        </div>
      )}

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
      {sendMode === 'ibc' && !isShield && (
        <div>
          <label className='mb-1 block text-xs text-fg-muted'>destination chain</label>
          {chainsLoading && !penumbraChannel ? (
            <div className='h-10 bg-elev-2 animate-pulse' />
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
            'w-full border bg-input px-3 py-2.5 text-sm text-fg',
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
            className='w-full border border-border-soft bg-input px-3 py-2.5 pr-14 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
          />
          {selectedAsset && spendable > 0n && (
            <button
              type='button'
              onClick={handleSetMax}
              className='absolute right-2 top-1/2 -translate-y-1/2 bg-elev-2 px-2 py-0.5 text-xs text-fg-muted transition-colors hover:bg-elev-1/80 hover:text-fg-high'
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
            className='w-full border border-border-soft bg-input px-3 py-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors duration-100 focus:border-penumbra-purple focus:outline-none'
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
        <div className='border border-border-soft bg-elev-2/20 p-3'>
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
        <div className='border border-green-500/40 bg-green-500/10 p-3'>
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
        <div className='border border-border-soft bg-canvas p-3'>
          <p className='text-sm mb-2'>name this contact</p>
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
                    address: recipient,
                    chainId: sourceChainId,
                  });
                  setShowContactModal(false);
                  setContactName('');
                }
              }}
              disabled={!contactName.trim()}
              className='flex-1 bg-zigner-gold px-3 py-1.5 text-xs text-zigner-gold-foreground transition-colors disabled:opacity-50'
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

      {/* confirmation summary */}
      {txStatus === 'confirm' && selectedAsset && (
        <div className='border border-zigner-gold/30 bg-elev-1 p-3'>
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
                <pre className='mt-2 max-h-48 overflow-auto bg-canvas p-2 text-label tabular text-fg-muted leading-relaxed'>
                  {JSON.stringify(txPreview, null, 2)}
                </pre>
              )}
            </div>
          )}

          <div className='flex gap-2 mt-3'>
            <Button variant='primary' onClick={() => void handleConfirm()} className='flex-1'>
              confirm & sign
            </Button>
            <Button variant='secondary' onClick={() => setTxStatus('idle')} className='flex-1'>
              back
            </Button>
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
