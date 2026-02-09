import { useMemo, memo } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/ui/table';
import { ValueViewComponent } from '@repo/ui/components/ui/value';
import { ValueView } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { getDisplayDenomFromView, getEquivalentValues } from '@penumbra-zone/getters/value-view';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { asValueView } from '@penumbra-zone/getters/equivalent-value';
import { useQuery } from '@tanstack/react-query';
import { viewClient, stakeClient } from '../../../clients';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { useSyncProgress } from '../../../hooks/full-sync-height';
import { bech32mIdentityKey } from '@penumbra-zone/bech32m/penumbravalid';

/** memoized equivalent values display */
const EquivalentValues = memo(({ valueView }: { valueView?: ValueView }) => {
  const equivalentValuesAsValueViews = useMemo(
    () => (getEquivalentValues.optional(valueView) ?? []).map(asValueView),
    [valueView]
  );

  return (
    <div className='flex flex-wrap gap-2'>
      {equivalentValuesAsValueViews.map(equivalentValueAsValueView => (
        <ValueViewComponent
          key={getDisplayDenomFromView(equivalentValueAsValueView)}
          view={equivalentValueAsValueView}
          variant='equivalent'
        />
      ))}
    </div>
  );
});
EquivalentValues.displayName = 'EquivalentValues';

/** memoized row component */
const AssetRow = memo(({ balance, currentBlockHeight, validatorName }: { balance: BalancesResponse; currentBlockHeight?: number; validatorName?: string }) => (
  <TableRow className='group'>
    <TableCell>
      <ValueViewComponent view={balance.balanceView} currentBlockHeight={currentBlockHeight} validatorName={validatorName} />
    </TableCell>
    <TableCell>
      <EquivalentValues valueView={balance.balanceView} />
    </TableCell>
  </TableRow>
));
AssetRow.displayName = 'AssetRow';

/** filter out non-displayable assets */
const filterBalances = (balances: BalancesResponse[]): BalancesResponse[] =>
  balances.filter(balance => {
    const metadata = getMetadataFromBalancesResponse.optional(balance);
    if (!metadata?.base || typeof metadata.base !== 'string') return true;

    return !(
      assetPatterns.auctionNft.matches(metadata.base) ||
      assetPatterns.lpNft.matches(metadata.base) ||
      assetPatterns.proposalNft.matches(metadata.base) ||
      assetPatterns.votingReceipt.matches(metadata.base)
    );
  });

/** sort by priority score descending */
const sortBalances = (balances: BalancesResponse[]): BalancesResponse[] =>
  [...balances].sort((a, b) => {
    const aScore = getMetadataFromBalancesResponse.optional(a)?.priorityScore ?? 0n;
    const bScore = getMetadataFromBalancesResponse.optional(b)?.priorityScore ?? 0n;
    return Number(bScore - aScore);
  });

export interface AssetsTableProps {
  account: number;
}

/** get validator name from unbonding token */
const getUnbondingValidatorId = (balance: BalancesResponse): string | undefined => {
  const metadata = getMetadataFromBalancesResponse.optional(balance);
  if (!metadata?.display) return undefined;
  const captured = assetPatterns.unbondingToken.capture(metadata.display);
  return captured?.idKey;
};

export const AssetsTable = ({ account }: AssetsTableProps) => {
  const { latestBlockHeight } = useSyncProgress();

  // fetch validators for name lookup
  const { data: validatorNames } = useQuery({
    queryKey: ['validator-names'],
    staleTime: 300_000, // 5 minutes
    queryFn: async () => {
      const map = new Map<string, string>();
      try {
        for await (const v of stakeClient.validatorInfo({})) {
          if (!v.validatorInfo?.validator?.identityKey?.ik) continue;
          const name = v.validatorInfo.validator.name || 'Unknown';
          const bech32 = bech32mIdentityKey({ ik: v.validatorInfo.validator.identityKey.ik });
          map.set(bech32, name);
        }
      } catch {
        // ignore errors
      }
      return map;
    },
  });

  const { data: rawBalances, isLoading, error } = useQuery({
    queryKey: ['balances', account],
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return await Array.fromAsync(viewClient.balances({ accountFilter: { account } }));
      } catch {
        return [];
      }
    },
  });

  // memoize expensive filter + sort operations
  const balances = useMemo(() => {
    if (!rawBalances?.length) return [];
    return sortBalances(filterBalances(rawBalances));
  }, [rawBalances]);

  if (isLoading) {
    return (
      <div className='flex items-center justify-center py-8 text-xs text-muted-foreground'>
        Loading...
      </div>
    );
  }

  if (error || !balances.length) {
    return (
      <div className='flex flex-col items-center justify-center gap-1 py-8 text-center'>
        <span className='text-sm text-muted-foreground'>No assets yet</span>
        <span className='text-xs text-muted-foreground/70'>
          Receive funds to get started
        </span>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader className='group'>
        <TableRow>
          <TableHead>Balance</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {balances.map((balance, i) => {
          const validatorId = getUnbondingValidatorId(balance);
          const validatorName = validatorId ? validatorNames?.get(validatorId) : undefined;
          return (
            <AssetRow key={i} balance={balance} currentBlockHeight={latestBlockHeight} validatorName={validatorName} />
          );
        })}
      </TableBody>
    </Table>
  );
};
