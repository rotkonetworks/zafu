/** penumbra ibc withdraw: out of the shielded pool to a cosmos chain, on the shared send steps */

import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getDisplayDenomExponent } from '@penumbra-zone/getters/metadata';
import { fromValueView } from '@penumbrafi/types/amount';
import {
  COSMOS_CHAINS,
  getCosmosChain,
  type CosmosChainId,
} from '@repo/wallet/networks/cosmos/chains';
import { Button } from '@repo/ui/components/ui/button';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';
import {
  selectPenumbraAccount,
  keyRingSelector,
  selectEffectiveKeyInfo,
} from '../../../state/keyring';
import { recentAddressesSelector } from '../../../state/recent-addresses';
import { contactsSelector } from '../../../state/contacts';
import { selectIbcWithdraw } from '../../../state/ibc-withdraw';
import { isValidWithdrawAmount } from '../../../state/ibc-withdraw-amount';
import { useIbcChains, isValidIbcAddress } from '../../../hooks/ibc-chains';
import { trackUnshieldOut } from '../../../state/ibc-transfer-probes';
import { selectWithdrawableBalances } from '../../../utils/is-fungible-asset';
import { balancesQueryOptions } from '../../../hooks/penumbra-balances';
import { allocateTransparentAddress } from '../../../transparent/hd';
import { ScreenHeader } from '../../../components/screen-header';
import { Sensitive } from '../../../components/sensitive';
import { SaveContactModal } from '../../../components/save-contact-modal';
import { IbcTransferStatusLine } from '../ibc-transfer-status';
import { EMPTY_BALANCES } from './shared';
import { Footer, Main, shortAddress } from './send-ui';
import { AmountField, AddressSheet, PickSheet, ToField } from './send-fields';
import { BalanceSheet, balanceLook } from './balance-sheet';
import { PenumbraFlow } from './penumbra-flow';
import { useChainInUse } from '../../../hooks/enable-network';

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

export function PenumbraIbcSend({ onClose, meta }: { onClose: () => void; meta?: ReactNode }) {
  const { data: chains = [], isLoading: chainsLoading } = useIbcChains();
  const ibcState = useStore(selectIbcWithdraw);
  const penumbraAccount = useStore(selectPenumbraAccount);
  // opt-in: send to a hand-entered address instead of our own burner deposit
  // address. Off by default - unshielding lands in our transparent burner.
  const [overrideAddress, setOverrideAddress] = useState(false);

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
  const { recordUsage, shouldSuggestSave } = useStore(recentAddressesSelector);
  const { findByAddress } = useStore(contactsSelector);

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
  // the withdrawal lands on this chain, and is followed there
  useChainInUse(cosmosChainId);

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
      (cosmosChainId && getCosmosChain(cosmosChainId).keyAlgo === 'eth_secp256k1')
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

  const handleMax = () => {
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
  };

  // Amount must be expressible in the asset's own base units: more fractional
  // digits than the exponent allows is a user error we surface up front rather
  // than silently truncating at plan time.
  const amountValid =
    ibcState.exponent !== undefined && isValidWithdrawAmount(ibcState.amount, ibcState.exponent);

  const canReview = !!ibcState.chain && addressValid && amountValid && !belowNobleMin;

  const [assetOpen, setAssetOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [sent, setSent] = useState<{ address: string; chainId?: string }>();

  const chainName = ibcState.chain?.displayName ?? 'cosmos';
  const to = ibcState.destinationAddress;
  const own = !!ownAddress && to === ownAddress;
  const toName = to ? findByAddress(to)?.contact.name : undefined;
  const { symbol } = balanceLook(selectedAsset);
  const unit = symbol.toLowerCase();
  const sending = (
    <>
      withdraw <Sensitive>{`${ibcState.amount} ${unit}`}</Sensitive> to {chainName}
    </>
  );
  const amountHelper = belowNobleMin
    ? `at least ${MIN_NOBLE_USDC_UNSHIELD} usdc, so noble's fee never strands it`
    : !!ibcState.amount && !amountValid
      ? ibcState.exponent === undefined
        ? 'no decimals known for this asset · please pick it again'
        : `up to ${ibcState.exponent} decimal places, please`
      : withdrawableAssets.length === 0 && ibcState.chain
        ? `nothing here can go to ${chainName} yet`
        : undefined;

  return (
    <PenumbraFlow
      onClose={onClose}
      tx={{
        sending,
        label: `withdraw ${ibcState.amount} ${symbol} to ${chainName}`,
        plan: () => ibcState.buildPlanRequest(),
        explainError: msg =>
          msg.includes('expired')
            ? `the ${chainName} channel is closed for now · nothing was sent`
            : msg,
        onSent: txId => {
          const destAddr = ibcState.destinationAddress;
          const chainId = ibcState.chain?.chainId;
          void recordUsage(destAddr, 'cosmos', chainId);
          setSent({ address: destAddr, chainId });
          // the relayer has no status api, so arrival is watched on the
          // destination balance; fields are read before reset() clears them
          if (trackChainId) {
            const meta = selectedAsset
              ? getMetadataFromBalancesResponse.optional(selectedAsset)
              : undefined;
            void trackUnshieldOut({
              srcTxHash: txId,
              amount: ibcState.amount,
              // the asset's decimals: INJ is 18, USDC.inj 6
              decimals: ibcState.exponent ?? getCosmosChain(trackChainId).decimals,
              symbol: meta?.symbol ?? meta?.display ?? ibcState.denom,
              destChainId: trackChainId,
              destAddress: destAddr,
              isNative: isNobleUsdc,
            }).catch(err => console.warn('failed to track unshield transfer:', err));
          }
          ibcState.reset();
        },
        review: {
          lead: 'you withdraw',
          amount: ibcState.amount,
          unit,
          rows: [
            [
              'to',
              own
                ? `your ${chainName} address`
                : toName
                  ? `${toName} · ${shortAddress(to)}`
                  : shortAddress(to),
            ],
            ['network', chainName],
            ['fee', 'shown before you approve'],
          ],
          privacy: `public on ${chainName} · the address and amount are visible`,
          confirm: 'sign & send',
        },
        done: sending,
      }}
      doneNote={txId => <IbcTransferStatusLine transferId={txId} />}
      doneActions={() =>
        sent &&
        shouldSuggestSave(sent.address) &&
        !findByAddress(sent.address) && (
          <>
            <Button variant='secondary' onClick={() => setSaveOpen(true)} className='px-3'>
              save contact
            </Button>
            {saveOpen && (
              <SaveContactModal
                address={sent.address}
                network='cosmos'
                onDone={() => setSaveOpen(false)}
                onCancel={() => setSaveOpen(false)}
              />
            )}
          </>
        )
      }
    >
      {review => (
        <>
          <ScreenHeader title='withdraw' onBack={onClose} meta={meta} />
          <Main className='gap-[18px] pt-5'>
            <RowGroup>
              <Row
                type='value'
                label='to network'
                value={chainsLoading ? 'reading' : (ibcState.chain?.displayName ?? 'choose')}
                disabled={chainsLoading}
                onPress={() => setChainOpen(true)}
              />
            </RowGroup>
            <ToField
              value={own ? shortAddress(to) : to}
              onChange={ibcState.setDestinationAddress}
              placeholder={ibcState.chain ? `${ibcState.chain.addressPrefix}1…` : 'address'}
              disabled={own || !ibcState.chain}
              warn={!!to && !addressValid}
              helper={
                own
                  ? `your own ${chainName} address · transparent`
                  : to && !addressValid
                    ? `that is not a ${chainName} address · please check it`
                    : toName
              }
              onContacts={own ? undefined : () => setBookOpen(true)}
            >
              {ownAddress && (
                <Button
                  variant='quiet'
                  size='sm'
                  onClick={() => {
                    setOverrideAddress(own);
                    ibcState.setDestinationAddress(own ? '' : ownAddress);
                  }}
                  className='self-start px-0 text-network-accent'
                >
                  {own ? 'send to another address' : 'use my own address'}
                </Button>
              )}
            </ToField>
            <AmountField
              value={ibcState.amount}
              onChange={ibcState.setAmount}
              unit={unit}
              onUnit={() => setAssetOpen(true)}
              available={selectedAsset ? selectedBalance : undefined}
              onMax={handleMax}
              canMax={!!selectedAsset}
              warn={belowNobleMin || (!!ibcState.amount && !amountValid)}
              helper={amountHelper}
            />
          </Main>
          <Footer>
            <Button onClick={review} disabled={!canReview} className='w-full'>
              review
            </Button>
          </Footer>
          <PickSheet
            title='to network'
            open={chainOpen}
            onOpenChange={setChainOpen}
            picks={chains.map(c => ({ key: c.chainId, label: c.displayName }))}
            onPick={id => ibcState.setChain(chains.find(c => c.chainId === id))}
          />
          <BalanceSheet
            open={assetOpen}
            onOpenChange={setAssetOpen}
            assets={withdrawableAssets}
            onPick={b => {
              const meta = getMetadataFromBalancesResponse.optional(b);
              setSelectedAsset(b);
              if (meta?.base) {
                ibcState.setDenom(meta.base, getDisplayDenomExponent.optional(meta));
              }
            }}
          />
          <AddressSheet
            chain='cosmos'
            open={bookOpen}
            onOpenChange={setBookOpen}
            own={ownAddress ? [{ label: 'your own address', address: ownAddress }] : []}
            onPick={row => ibcState.setDestinationAddress(row.address)}
          />
        </>
      )}
    </PenumbraFlow>
  );
}
