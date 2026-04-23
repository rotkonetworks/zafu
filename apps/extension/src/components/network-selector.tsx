/**
 * network selector for send/receive pages
 * solidjs-style: atomic selectors, composable primitives
 */

import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../state';
import { selectEnabledNetworks, type NetworkType } from '../state/keyring';
import { NETWORKS, LAUNCHED_NETWORKS } from '../config/networks';
import { Dropdown } from './primitives/dropdown';
import { NetworkIcon } from './network-icons';

export interface NetworkInfo {
  id: NetworkType;
  name: string;
  color: string;
  testnet?: boolean;
}

/** derive supported networks from config — only launched networks */
export const SUPPORTED_NETWORKS: NetworkInfo[] = LAUNCHED_NETWORKS.map(id => ({
  id,
  name: NETWORKS[id].name,
  color: NETWORKS[id].color.replace('bg-', ''), // strip tailwind prefix for inline style
}));

interface NetworkSelectorProps {
  currentNetwork: NetworkInfo;
  onNetworkChange: (network: NetworkInfo) => void;
  networks?: NetworkInfo[];
  onAddNetwork?: () => void;
  className?: string;
}

export const NetworkSelector = ({
  currentNetwork,
  onNetworkChange,
  networks = SUPPORTED_NETWORKS,
  onAddNetwork,
  className,
}: NetworkSelectorProps) => {
  // atomic selector - only re-renders when enabledNetworks changes
  const enabledNetworks = useStore(selectEnabledNetworks);

  // filter to only enabled networks
  const activeNetworks = networks.filter(n =>
    enabledNetworks.includes(n.id)
  );

  return (
    <Dropdown
      trigger={({ toggle, open }) => (
        <button
          onClick={toggle}
          className={cn(
            'flex items-center gap-2 rounded-lg border border-border-soft bg-background/50 px-2.5 py-1.5 text-sm',
            'transition-colors hover:bg-elev-1',
            className
          )}
        >
          <NetworkIcon network={currentNetwork.id} color={currentNetwork.color} size='sm' />
          <span className='max-w-[80px] truncate font-medium'>{currentNetwork.name}</span>
          {currentNetwork.testnet && (
            <span className='text-[10px] text-fg-muted'>testnet</span>
          )}
          <span className={cn('i-lucide-chevron-down h-4 w-4 text-fg-muted transition-transform', open && 'rotate-180')} />
        </button>
      )}
    >
      {({ close }) => (
        <div className='absolute right-0 top-full z-50 mt-1 w-52 max-h-60 overflow-y-auto rounded-lg border border-border-soft bg-canvas shadow-lg'>
          <div className='p-1'>
            <div className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted'>
              active networks
            </div>
            {activeNetworks.map(network => (
              <button
                key={network.id}
                onClick={() => {
                  onNetworkChange(network);
                  close();
                }}
                className={cn(
                  'flex w-full items-center justify-between px-2 py-1.5 text-sm transition-colors',
                  network.id === currentNetwork.id ? 'bg-elev-2' : 'hover:bg-elev-1'
                )}
              >
                <div className='flex items-center gap-2'>
                  <NetworkIcon network={network.id} color={network.color} size='sm' />
                  <span>{network.name}</span>
                  {network.testnet && (
                    <span className='text-[10px] text-fg-muted'>testnet</span>
                  )}
                </div>
                {network.id === currentNetwork.id && (
                  <div className='h-1.5 w-1.5 bg-zigner-gold' />
                )}
              </button>
            ))}
          </div>

          {onAddNetwork && (
            <div className='border-t border-border-soft p-1'>
              <button
                onClick={() => {
                  close();
                  onAddNetwork();
                }}
                className='flex w-full items-center gap-2 px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-elev-1 hover:text-fg-high'
              >
                <span className='i-lucide-plus h-4 w-4' />
                <span>add network</span>
              </button>
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
};
