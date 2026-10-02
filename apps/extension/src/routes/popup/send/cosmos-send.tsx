/**
 * cosmos chain send form (skip-routed transparent sends)
 */

import { ThorNameResolver } from '../../../components/thorname-resolver';
import { isThorName, thorChainOf } from '../../../services/thorname';
import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from 'react';
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
import { useChainCheck, useCosmosAssets, type CosmosAsset } from '../../../hooks/cosmos-balance';
import {
  COSMOS_CHAINS,
  type CosmosChainId,
  isValidCosmosAddress,
  getChainFromAddress,
} from '@repo/wallet/networks/cosmos/chains';
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
import { Input } from '@repo/ui/components/ui/input';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useCopy } from '@repo/ui/hooks/use-copy';
import { ScreenHeader } from '../../../components/screen-header';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { Done, Footer, Helper, Main, Review, Sending, Stopped } from './send-ui';
import { AmountField, ContactsSheet, PickSheet, ToField } from './send-fields';
import { STAGES } from './send-stage';
import { useChainInUse } from '../../../hooks/enable-network';

// Penumbra's Skip/registry chain id. Shielding USDC INTO penumbra is a direct
// single-hop IBC MsgTransfer over our own relayed channel, NOT a Skip route -
// so this id is special-cased throughout the cosmos send flow below.
const PENUMBRA_CHAIN_ID = 'penumbra-1';

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
  onClose,
  meta,
  above,
}: {
  sourceChainId: CosmosChainId;
  initialAccountIndex?: number;
  /** 'shield' opens straight on "into my Penumbra wallet" */
  intent?: 'send' | 'shield';
  onClose: () => void;
  /** the header's mode switch */
  meta?: ReactNode;
  /** first in the form, e.g. which transparent chain */
  above?: ReactNode;
}) {
  const sourceChain = COSMOS_CHAINS[sourceChainId];
  useChainInUse(sourceChainId);
  // the live chain -> penumbra channel (discovered, never an expired pin);
  // undefined when the chain has no route into penumbra right now
  const penumbraChannel = routeForChain(sourceChainId, usePenumbraRoutes())?.penumbraChannel;
  const isEthermint = sourceChain.keyAlgo === 'eth_secp256k1';
  // two ways to move funds out of a cosmos/burner wallet: same-chain (e.g. to a
  // Noble exchange deposit address) or cross-chain via IBC (Skip routing).
  // a shield has exactly one destination (penumbra over IBC), so the mode and
  // destination-chain pickers don't apply to it
  const isShield = intent === 'shield' && !!penumbraChannel;
  const [destChainId, setDestChainId] = useState<string | undefined>(
    isShield ? PENUMBRA_CHAIN_ID : undefined,
  );
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<CosmosAsset | undefined>();
  // The address being spent: the caller's pick, changeable among the funded
  // ones. Locked while a tx is in flight.
  const [accountIndex, setAccountIndex] = useState(initialAccountIndex ?? 0);
  const { state: depositState, check: checkDeposits } = useChainCheck(sourceChainId);
  const deposits = 'check' in depositState ? depositState.check : undefined;
  // opening the send form is the user asking: check the burners once if never checked
  useEffect(() => {
    if (depositState.kind === 'unchecked') {
      void checkDeposits();
    }
  }, [depositState.kind]);
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
    const total = (w: (typeof deposits.funded)[number]) =>
      w.assets.reduce((sum, x) => sum + x.amount, 0n);
    const top = [...deposits.funded].sort((a, b) =>
      ramp(a) !== ramp(b) ? (ramp(b) > ramp(a) ? 1 : -1) : total(b) > total(a) ? 1 : -1,
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
  const [showContactModal, setShowContactModal] = useState(false);
  const [txPreview, setTxPreview] = useState<Record<string, unknown> | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [pick, setPick] = useState<'asset' | 'from' | 'chain' | 'book'>();
  const signStartRef = useRef(0);

  // detect wallet type
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const isZigner = cosmosKeyFor(selectedKeyInfo, sourceChainId)?.signer === 'zigner';

  // recent addresses and contacts
  const { recordUsage, shouldSuggestSave } = useStore(recentAddressesSelector);
  const { findByAddress } = useStore(contactsSelector);

  const { data: skipChains = [], isLoading: chainsLoading } = useSkipChains();

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
    const current = assetsData?.address
      ? [{ index: accountIndex, address: assetsData.address, assets: [] }]
      : [];
    const rows = funded.some(w => w.index === accountIndex) ? funded : [...funded, ...current];
    return rows.map(w => ({
      index: w.index,
      address: w.address,
      summary: w.assets[0]
        ? `${w.assets[0].formatted}${w.assets.length > 1 ? ` +${w.assets.length - 1}` : ''}`
        : 'empty',
    }));
  }, [deposits, accountIndex, assetsData?.address]);
  // auto-detect destination chain from address
  const detectedChain = useMemo(() => {
    if (!recipient) {
      return undefined;
    }
    return getChainFromAddress(recipient);
  }, [recipient]);

  // effective destination: manual selection > the pasted address > same chain
  const effectiveDestChainId = destChainId || detectedChain?.chainId || sourceChain.chainId;
  const isSameChain = effectiveDestChainId === sourceChain.chainId;
  const gas = useGasSponsor(sourceChainId, isSameChain ? 'send' : 'ibc', assetsData?.assets);
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
    setDestChainId(undefined);
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
    void checkDeposits();
    setRecipient('');
    setTxHash(undefined);
    setTxStatus('idle');
    setDestChainId(isShield ? PENUMBRA_CHAIN_ID : undefined);
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

    signStartRef.current = Date.now();
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

  const { copied, copy } = useCopy();
  const sym = selectedAsset?.symbol ?? sourceChain.symbol;
  const unit = sym.toLowerCase();
  const fee = payWithSponsor
    ? 'covered by the rotko sponsor'
    : `${formatBaseUnits(gas.fee, gas.gasAsset.decimals, 6)} ${gas.gasAsset.symbol.toLowerCase()}`;
  const destName = isPenumbraDest
    ? 'penumbra'
    : (skipChains.find(c => c.chainId === effectiveDestChainId)?.chainName ?? effectiveDestChainId);
  const toName = recipient ? findByAddress(recipient)?.contact.name : undefined;
  const toLabel =
    isPenumbraDest && !toName ? 'your penumbra wallet' : (toName ?? shortAddress(toAddress));
  const verb = isPenumbraDest ? 'shield' : 'send';
  const sending = (
    <>
      {verb} <Sensitive>{`${amount} ${unit}`}</Sensitive> to {toLabel}
    </>
  );
  const thorChain = thorChainOf('cosmos', effectiveDestChainId);
  const badRecipient =
    !!recipient && !recipientValid && !(thorChain && isThorName(recipient.trim()));
  const toHelper = badRecipient
    ? ethermintRecipient && !ethermintRecipient.ok
      ? ETHERMINT_RECIPIENT_PROBLEM[ethermintRecipient.problem](ethermintRecipient.prefix)
      : `that is not a ${isPenumbraDest ? 'penumbra' : 'cosmos'} address · please check it`
    : ethermintRecipient?.ok && ethermintRecipient.fromHex
      ? `sends to ${shortAddress(toAddress)}`
      : !isSameChain && detectedChain && !destChainId
        ? `on ${detectedChain.name}`
        : toName;
  const amountHelper = exceeds
    ? 'a little more than this address holds'
    : !canPayFee
      ? `no ${gas.gasAsset.symbol.toLowerCase()} on this address for the fee`
      : routeError && !isPenumbraDest
        ? routeError.message.toLowerCase()
        : route
          ? `arrives as ${(parseFloat(route.amountOut) / 1e6).toFixed(6)}${route.doesSwap && route.swapVenue ? ` via ${route.swapVenue.name}` : ''}`
          : routeLoading
            ? 'finding a route'
            : `fee ${fee}`;

  const steps = {
    idle: () => (
      <>
        <ScreenHeader
          title={isShield ? 'shield into penumbra' : 'send'}
          onBack={onClose}
          meta={meta}
        />
        <Main className='gap-[18px] pt-5'>
          {above}
          {(assetsData?.address || !isShield) && (
            <RowGroup>
              {assetsData?.address && (
                <Row
                  type='value'
                  label='from'
                  description={shortAddress(assetsData.address)}
                  value={
                    fromOptions.find(w => w.index === accountIndex)?.summary ?? sourceChain.name
                  }
                  disabled={fromOptions.length < 2}
                  onPress={() => setPick('from')}
                />
              )}
              {!isShield && (
                <Row
                  type='value'
                  label='to network'
                  value={
                    destChainId
                      ? destName
                      : detectedChain
                        ? `auto · ${detectedChain.name}`
                        : chainsLoading && !penumbraChannel
                          ? 'reading'
                          : 'from the address'
                  }
                  onPress={() => setPick('chain')}
                />
              )}
            </RowGroup>
          )}
          <ToField
            value={recipient}
            onChange={setRecipient}
            placeholder='address'
            warn={badRecipient}
            helper={toHelper}
            onContacts={isPenumbraDest ? undefined : () => setPick('book')}
          >
            <ThorNameResolver input={recipient} chain={thorChain} onResolve={setRecipient} />
            {isPenumbraDest && selectedKeyInfo?.type === 'mnemonic' && (
              <Button
                variant='quiet'
                size='sm'
                onClick={() => void fillOwnPenumbra()}
                className='self-start px-0 text-network-accent'
              >
                my penumbra wallet
              </Button>
            )}
          </ToField>
          <AmountField
            value={amount}
            onChange={setAmount}
            unit={unit}
            onUnit={(assetsData?.assets.length ?? 0) > 1 ? () => setPick('asset') : undefined}
            available={selectedAsset?.formatted}
            onMax={handleSetMax}
            canMax={!!selectedAsset && spendable > 0n}
            warn={exceeds || !canPayFee}
            helper={amountHelper}
            disabled={assetsLoading}
          />
          {!canPayFee && !topUp && assetsData?.address && (
            <div className='-mt-3 flex flex-wrap gap-x-3'>
              {gasDonors.slice(0, 2).map(w => (
                <Button
                  key={w.index}
                  variant='quiet'
                  size='sm'
                  onClick={() => startTopUp(w.index)}
                  className='px-0 text-network-accent'
                >
                  move {gas.gasAsset.symbol.toLowerCase()} here from #{w.index} (
                  {formatBaseUnits(gasOf(w), gas.gasAsset.decimals, 4)})
                </Button>
              ))}
              <Button
                variant='quiet'
                size='sm'
                onClick={() => copy(assetsData.address)}
                className='px-0'
              >
                {copied ? 'copied' : 'copy this address to top up'}
              </Button>
            </div>
          )}
          {topUp && (
            <Helper>
              moving {gas.gasAsset.symbol.toLowerCase()} to {shortAddress(topUp.to)} for gas
            </Helper>
          )}
          {/* exchanges often credit a deposit only with a memo; penumbra can't carry one */}
          {!isPenumbraDest && (
            <div className='flex flex-col gap-1.5'>
              <label htmlFor='cosmos-send-memo' className='text-xs text-fg-muted'>
                memo
              </label>
              <Input
                id='cosmos-send-memo'
                placeholder='optional, if the exchange needs one'
                value={memo}
                onChange={e => setMemo(e.target.value)}
                variant={memoLooksLikeMnemonic(memo) ? 'warn' : 'default'}
              />
              <Helper warn>
                {memoLooksLikeMnemonic(memo) &&
                  'that looks like a recovery phrase · please never put it in a memo'}
              </Helper>
            </div>
          )}
          {!isSameChain && !isShield && (
            <Button
              variant='quiet'
              size='sm'
              onClick={() => void chrome.tabs.create({ url: 'https://go.skip.build/' })}
              className='self-start px-0'
            >
              <span className='i-ph-arrow-square-out size-3' />
              or route it on go.skip.build
            </Button>
          )}
        </Main>
        <Footer>
          {topUp && (
            <Button variant='secondary' onClick={finishTopUp} className='w-[110px]'>
              cancel
            </Button>
          )}
          <Button onClick={handleReview} disabled={!canSubmit} className='grow'>
            {routeLoading ? 'finding a route' : 'review'}
          </Button>
        </Footer>
        <PickSheet
          title='asset'
          open={pick === 'asset'}
          onOpenChange={o => setPick(o ? 'asset' : undefined)}
          picks={(assetsData?.assets ?? []).map(a => ({
            key: a.denom,
            label: a.symbol,
            value: a.formatted,
          }))}
          onPick={d => setSelectedAsset(assetsData?.assets.find(a => a.denom === d))}
        />
        <PickSheet
          title='from'
          open={pick === 'from'}
          onOpenChange={o => setPick(o ? 'from' : undefined)}
          picks={fromOptions.map(w => ({
            key: w.index,
            label: `#${w.index} ${shortAddress(w.address)}`,
            value: w.summary,
          }))}
          onPick={setAccountIndex}
        />
        <PickSheet
          title='to network'
          open={pick === 'chain'}
          onOpenChange={o => setPick(o ? 'chain' : undefined)}
          picks={[
            { key: '', label: 'from the address' },
            ...destChains
              .filter(c => c.chainId !== sourceChain.chainId)
              .map(c => ({ key: c.chainId, label: c.chainName })),
          ]}
          onPick={id => {
            setDestChainId(id || undefined);
            setRecipient('');
          }}
        />
        <ContactsSheet
          network='cosmos'
          open={pick === 'book'}
          onOpenChange={o => setPick(o ? 'book' : undefined)}
          onPick={row => setRecipient(row.address)}
        />
      </>
    ),
    confirm: () => (
      <Review
        lead={isPenumbraDest ? 'you shield' : 'you send'}
        amount={amount}
        unit={unit}
        rows={[
          [
            'from',
            `${sourceChain.name.toLowerCase()} · ${shortAddress(assetsData?.address ?? '')}`,
          ],
          isPenumbraDest
            ? ['into', 'penumbra · shielded']
            : ['to', toName ? `${toName} · ${shortAddress(toAddress)}` : shortAddress(toAddress)],
          ...(isSameChain || isPenumbraDest ? [] : [['network', destName] as const]),
          ['fee', fee],
        ]}
        privacy={
          isPenumbraDest
            ? 'after this, these funds stay private'
            : 'public · the address and amount are visible to anyone'
        }
        confirm={isZigner ? 'sign on zigner' : isPenumbraDest ? 'shield' : 'sign & send'}
        onEdit={() => setTxStatus('idle')}
        onConfirm={() => void handleConfirm()}
      >
        {txPreview && (
          <Button
            variant='quiet'
            size='sm'
            onClick={() => setShowRawJson(true)}
            className='self-start px-0'
          >
            view the raw transaction
          </Button>
        )}
        <Sheet open={showRawJson} onOpenChange={setShowRawJson} title='raw transaction'>
          <pre className='max-h-[60vh] overflow-auto bg-canvas p-2 text-label text-fg-muted'>
            {JSON.stringify(txPreview, null, 2)}
          </pre>
        </Sheet>
      </Review>
    ),
    signing: () => (
      <Sending
        meta={sending}
        stages={STAGES.cosmos}
        steps={[]}
        floor={0}
        since={signStartRef.current}
        hot={!isZigner}
        onClose={onClose}
      />
    ),
    success: () => (
      <Done line={sending} txHash={txHash} onDone={topUp ? finishTopUp : onClose}>
        {!topUp && showSavePrompt && !isPenumbraDest && recipient && !findByAddress(toAddress) && (
          <Button variant='secondary' onClick={() => setShowContactModal(true)} className='px-3'>
            save contact
          </Button>
        )}
        {showContactModal && (
          <SaveContactModal
            address={toAddress}
            network='cosmos'
            onDone={() => {
              setShowContactModal(false);
              setShowSavePrompt(false);
            }}
            onCancel={() => setShowContactModal(false)}
          />
        )}
      </Done>
    ),
    error: () => (
      <Stopped
        sending={sending}
        error={txError}
        onCancel={onClose}
        onRetry={() => setTxStatus('idle')}
      />
    ),
  };

  return (
    <div className='flex h-full flex-col bg-canvas'>
      {PasswordModal}
      {steps[txStatus === 'broadcasting' ? 'signing' : txStatus]()}
    </div>
  );
}
