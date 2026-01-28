import { lazy, Suspense, useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpIcon, ArrowDownIcon, CopyIcon, CheckIcon } from '@radix-ui/react-icons';

import { useStore } from '../../../state';
import { selectActiveNetwork, selectSelectedKeyInfo, type NetworkType } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { localExtStorage } from '@repo/storage-chrome/local';
import { needsLogin, needsOnboard } from '../popup-needs';
import { PopupPath } from '../paths';
import { AssetListSkeleton } from '../../../components/primitives/skeleton';
import { usePreloadBalances } from '../../../hooks/use-preload';
import { useActiveAddress } from '../../../hooks/use-address';
import { usePolkadotPublicKey } from '../../../hooks/use-polkadot-key';

/** lazy load network-specific content - only load when needed */
const AssetsTable = lazy(() => import('./assets-table').then(m => ({ default: m.AssetsTable })));
const PolkadotAssets = lazy(() => import('./polkadot-assets').then(m => ({ default: m.PolkadotAssets })));
const BlockSync = lazy(() => import('./block-sync').then(m => ({ default: m.BlockSync })));

export interface PopupLoaderData {
  fullSyncHeight?: number;
}

export const popupIndexLoader = async (): Promise<Response | PopupLoaderData> => {
  await needsOnboard();
  const redirect = await needsLogin();
  if (redirect) return redirect;
  return { fullSyncHeight: await localExtStorage.get('fullSyncHeight') };
};

export const PopupIndex = () => {
  // atomic selectors - each only re-renders when its value changes
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const { address } = useActiveAddress();
  const { publicKey: polkadotPublicKey } = usePolkadotPublicKey();

  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  // preload balances in background for instant display
  usePreloadBalances();

  // dismiss backup reminder on first load
  useEffect(() => {
    void localExtStorage.get('backupReminderSeen').then(seen => {
      if (seen === false) void localExtStorage.set('backupReminderSeen', true);
    });
  }, []);

  const copyAddress = useCallback(() => {
    if (!address) return;
    setCopied(true);
    void navigator.clipboard.writeText(address);
    setTimeout(() => setCopied(false), 1200);
  }, [address]);

  // derive wallet name - no extra state needed
  const walletName = activeNetwork === 'zcash'
    ? activeZcashWallet?.label ?? 'no wallet'
    : selectedKeyInfo?.name ?? 'no wallet';

  // truncate address for display
  const displayAddress = address
    ? `${address.slice(0, 12)}...${address.slice(-8)}`
    : walletName;

  return (
    <div className='flex min-h-full flex-col'>
      <div className='flex flex-col gap-3 p-4'>
        {/* balance + actions row */}
        <div className='flex items-center justify-between border border-border/40 bg-card p-4'>
          <div>
            <div className='text-xs text-muted-foreground'>balance</div>
            <div className='text-2xl font-semibold tabular-nums text-foreground'>
              {activeNetwork === 'zcash' ? '0 ZEC' : '$0.00'}
            </div>
            <button
              onClick={copyAddress}
              disabled={!address}
              className='mt-1 flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-100 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed'
            >
              <span className='font-mono'>{displayAddress}</span>
              {address && (copied ? <CheckIcon className='h-3 w-3' /> : <CopyIcon className='h-3 w-3' />)}
            </button>
          </div>

          <div className='flex gap-2'>
            <button
              onClick={() => navigate(PopupPath.RECEIVE)}
              className='flex h-10 w-10 items-center justify-center bg-muted transition-all duration-100 hover:bg-muted/80 active:scale-95'
              title='receive'
            >
              <ArrowDownIcon className='h-5 w-5' />
            </button>
            <button
              onClick={() => navigate(PopupPath.SEND)}
              className='flex h-10 w-10 items-center justify-center bg-primary text-primary-foreground transition-all duration-100 hover:bg-primary/90 active:scale-95'
              title='send'
            >
              <ArrowUpIcon className='h-5 w-5' />
            </button>
          </div>
        </div>

        {/* network-specific content - lazy loaded with skeleton */}
        <Suspense fallback={<AssetListSkeleton rows={4} />}>
          <NetworkContent
            network={activeNetwork}
            zcashWallet={activeZcashWallet}
            polkadotPublicKey={polkadotPublicKey}
          />
        </Suspense>
      </div>
    </div>
  );
};

/** network-specific content - split out to minimize re-renders */
const NetworkContent = ({
  network,
  zcashWallet,
  polkadotPublicKey,
}: {
  network: NetworkType;
  zcashWallet?: { label: string; mainnet: boolean };
  polkadotPublicKey?: string;
}) => {
  switch (network) {
    case 'penumbra':
      return (
        <div className='flex-1'>
          {/* sync status bar */}
          <Suspense fallback={null}>
            <div className='mb-3'>
              <BlockSync />
            </div>
          </Suspense>
          <div className='mb-2 text-xs font-medium text-muted-foreground'>assets</div>
          <AssetsTable account={0} />
        </div>
      );

    case 'zcash':
      return <ZcashContent wallet={zcashWallet} />;

    case 'polkadot':
      return <PolkadotContent publicKey={polkadotPublicKey} />;

    case 'kusama':
      return <PolkadotContent publicKey={polkadotPublicKey} relay='kusama' />;

    default:
      return <NetworkPlaceholder network={network} />;
  }
};

/** zcash-specific content */
const ZcashContent = ({ wallet }: { wallet?: { label: string; mainnet: boolean } }) => {
  if (!wallet) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-center'>
        <div className='text-sm text-muted-foreground'>no zcash wallet</div>
<div className='text-xs text-muted-foreground mt-1'>add a wallet from zafu zigner to get started</div>
      </div>
    );
  }

  return (
    <div className='flex-1'>
      <div className='mb-2 text-xs font-medium text-muted-foreground'>shielded pool</div>
      <div className='border border-border bg-card p-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <div className='h-8 w-8 bg-zigner-gold/20 flex items-center justify-center'>
              <span className='text-zigner-gold text-sm font-bold'>Z</span>
            </div>
            <div>
              <div className='text-sm font-medium'>orchard</div>
              <div className='text-xs text-muted-foreground'>
                {wallet.mainnet ? 'mainnet' : 'testnet'}
              </div>
            </div>
          </div>
          <div className='text-right'>
            <div className='text-sm font-medium tabular-nums'>0.00000000 ZEC</div>
            <div className='text-xs text-muted-foreground'>$0.00</div>
          </div>
        </div>
      </div>
      <div className='mt-4 text-xs text-muted-foreground text-center'>
        balance syncing coming soon
      </div>
    </div>
  );
};

/** polkadot/kusama content */
const PolkadotContent = ({
  publicKey,
  relay = 'polkadot',
}: {
  publicKey?: string;
  relay?: 'polkadot' | 'kusama';
}) => {
  if (!publicKey) {
    return (
      <div className='flex flex-col items-center justify-center py-8 text-center'>
        <div className='text-sm text-muted-foreground'>no {relay} wallet</div>
        <div className='text-xs text-muted-foreground mt-1'>
          import a polkadot account to get started
        </div>
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

/** placeholder for networks not yet implemented */
const NetworkPlaceholder = ({ network }: { network: NetworkType }) => (
  <div className='flex flex-col items-center justify-center py-8 text-center'>
    <div className='text-sm text-muted-foreground'>{network} support coming soon</div>
  </div>
);
