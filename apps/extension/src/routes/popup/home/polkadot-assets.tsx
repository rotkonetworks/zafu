/**
 * polkadot ecosystem assets display
 *
 * uses smart balance caching - lazy connections, skip dormant chains
 */

import { useState, useEffect, useCallback, memo } from 'react';
import { ReloadIcon } from '@radix-ui/react-icons';
import { localExtStorage } from '@repo/storage-chrome/local';
import {
  getBalances,
  refreshChains,
  setEnabledChains,
  type ChainBalance,
  type SupportedChain,
  type RelayChain,
} from '@repo/wallet/networks/polkadot';

/** format balance for display */
function formatBalance(planck: bigint, decimals: number, maxDecimals = 4): string {
  const value = Number(planck) / Math.pow(10, decimals);
  return value.toLocaleString(undefined, { maximumFractionDigits: maxDecimals });
}

interface PolkadotAssetsProps {
  publicKey: string;
  relay?: RelayChain;
}

/** single chain balance row */
const ChainRow = memo(({ balance }: { balance: ChainBalance }) => (
  <div className='flex items-center justify-between py-2 px-3 border-b border-border/20 last:border-0'>
    <div className='flex items-center gap-2'>
      <div className='h-6 w-6 bg-primary/10 flex items-center justify-center text-xs font-bold'>
        {balance.symbol.slice(0, 2)}
      </div>
      <div className='flex flex-col'>
        <span className='text-sm font-medium'>{balance.chainName}</span>
        <span className='text-xs text-muted-foreground'>{balance.symbol}</span>
      </div>
    </div>
    <div className='text-right'>
      <div className='text-sm font-medium tabular-nums'>
        {formatBalance(balance.balance, balance.decimals, 4)} {balance.symbol}
      </div>
      {balance.cached && (
        <div className='text-xs text-muted-foreground/70'>cached</div>
      )}
    </div>
  </div>
));
ChainRow.displayName = 'ChainRow';

export const PolkadotAssets = ({ publicKey, relay = 'polkadot' }: PolkadotAssetsProps) => {
  const [balances, setBalances] = useState<ChainBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // load enabled chains and fetch balances
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        // load enabled parachains from storage
        const stored = await localExtStorage.get('enabledParachains') as Record<string, string[]> | undefined;
        const enabledIds = stored?.[relay] ?? [];

        // always include the relay chain itself (e.g., polkadot, kusama)
        const chains: SupportedChain[] = [relay as SupportedChain, ...(enabledIds as SupportedChain[])];
        setEnabledChains(chains);

        // fetch balances (uses cache when available)
        const result = await getBalances(relay, publicKey);
        setBalances(result);
      } catch (err) {
        console.error('failed to load balances:', err);
      }
      setLoading(false);
    };

    void load();
  }, [publicKey, relay]);

  // force refresh all chains
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const stored = await localExtStorage.get('enabledParachains') as Record<string, string[]> | undefined;
      const enabledIds = stored?.[relay] ?? [];
      const chains: SupportedChain[] = [relay as SupportedChain, ...(enabledIds as SupportedChain[])];

      const result = await refreshChains(publicKey, chains);
      setBalances(result);
    } catch (err) {
      console.error('failed to refresh:', err);
    }
    setRefreshing(false);
  }, [publicKey, relay]);

  if (loading) {
    return (
      <div className='flex items-center justify-center py-8'>
        <ReloadIcon className='h-5 w-5 animate-spin text-muted-foreground' />
      </div>
    );
  }

  return (
    <div className='flex flex-col'>
      <div className='flex items-center justify-between mb-2'>
        <span className='text-xs font-medium text-muted-foreground'>
          {relay} ecosystem
        </span>
        <button
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className='text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50'
        >
          {refreshing ? (
            <ReloadIcon className='h-3 w-3 animate-spin' />
          ) : (
            'refresh'
          )}
        </button>
      </div>

      <div className='border border-border/40 bg-card'>
        {balances.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-6 text-center'>
            <span className='text-sm text-muted-foreground'>no balances</span>
            <span className='text-xs text-muted-foreground/70 mt-1'>
              enable parachains in settings
            </span>
          </div>
        ) : (
          balances.map(balance => (
            <ChainRow key={balance.chain} balance={balance} />
          ))
        )}
      </div>
    </div>
  );
};

export default PolkadotAssets;
