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
import { viewClient } from '../../../clients';
import { assetPatterns } from '@rotko/penumbra-types/assets';
import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';

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
const AssetRow = memo(({ balance }: { balance: BalancesResponse }) => (
  <TableRow className='group'>
    <TableCell>
      <ValueViewComponent view={balance.balanceView} />
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

export const AssetsTable = ({ account }: AssetsTableProps) => {
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
        {balances.map((balance, i) => (
          <AssetRow key={i} balance={balance} />
        ))}
      </TableBody>
    </Table>
  );
};
