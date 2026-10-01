import { lazy, Suspense } from 'react';

import { Sensitive } from '../../../components/sensitive';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { useCosmosAssets } from '../../../hooks/cosmos-balance';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import type { NetworkType } from '../../../state/keyring';

const PolkadotAssets = lazy(() =>
  import('./polkadot-assets').then(m => ({ default: m.PolkadotAssets })),
);

/** polkadot/kusama content */
export const PolkadotContent = ({
  publicKey,
  relay = 'polkadot',
}: {
  publicKey?: string;
  relay?: 'polkadot' | 'kusama';
}) => {
  if (!publicKey) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>no {relay} wallet</div>
        <div className='text-xs text-fg-muted mt-1'>import a polkadot account to get started</div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <Suspense fallback={<AssetListSkeleton rows={3} />}>
        <PolkadotAssets publicKey={publicKey} relay={relay} />
      </Suspense>
    </div>
  );
};

/** cosmos chain content - shows balances from public RPC */
export const CosmosContent = ({ chainId }: { chainId: CosmosChainId }) => {
  const config = COSMOS_CHAINS[chainId];

  const { data: assetsData, isLoading, error } = useCosmosAssets(chainId, 0);

  if (error) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>failed to load balances</div>
        <div className='text-xs text-fg-muted mt-1'>
          {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  if (!assetsData && !isLoading) {
    return (
      <div className='flex flex-col items-center justify-center py-12 text-center'>
        <div className='text-sm text-fg-muted'>
          enable transparent balance fetching in privacy settings to view {config.name} balances
        </div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <div className='kicker mb-2'>assets</div>
      {isLoading ? (
        <AssetListSkeleton rows={2} />
      ) : assetsData?.assets.length === 0 ? (
        <div className='border border-border-soft bg-elev-1 p-4'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <div className='h-8 w-8 bg-elev-2 flex items-center justify-center'>
                <span className='text-sm font-bold'>{config.symbol[0]}</span>
              </div>
              <div>
                <div className='text-sm font-medium'>{config.symbol}</div>
                <div className='text-xs text-fg-muted'>{config.name}</div>
              </div>
            </div>
            <div className='text-right'>
              <Sensitive className='text-sm font-medium tabular-nums'>0 {config.symbol}</Sensitive>
            </div>
          </div>
        </div>
      ) : (
        <div className='flex flex-col gap-1'>
          {assetsData?.assets.map(asset => (
            <div key={asset.denom} className='border border-border-soft bg-elev-1 p-4'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <div className='h-8 w-8 bg-elev-2 flex items-center justify-center'>
                    <span className='text-sm font-bold'>{asset.symbol[0]}</span>
                  </div>
                  <div>
                    <div className='text-sm font-medium'>{asset.symbol}</div>
                    <div className='text-xs text-fg-muted truncate max-w-[120px]'>
                      {asset.denom}
                    </div>
                  </div>
                </div>
                <div className='text-right'>
                  <Sensitive className='text-sm font-medium tabular-nums'>
                    {asset.formatted}
                  </Sensitive>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** placeholder for networks not yet implemented */
export const NetworkPlaceholder = ({ network }: { network: NetworkType }) => (
  <div className='flex flex-col items-center justify-center py-12 text-center'>
    <div className='text-sm text-fg-muted'>{network} support coming soon</div>
  </div>
);
