/**
 * network selector for send/receive pages
 * solidjs-style: atomic selectors, composable primitives
 */

import { ChevronDownIcon, PlusIcon } from '@radix-ui/react-icons';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../state';
import { selectEnabledNetworks, type NetworkType } from '../state/keyring';
import { NETWORKS } from '../config/networks';
import { Dropdown } from './primitives/dropdown';

export interface NetworkInfo {
  id: NetworkType;
  name: string;
  color: string;
  testnet?: boolean;
}

/** derive supported networks from config */
export const SUPPORTED_NETWORKS: NetworkInfo[] = (Object.keys(NETWORKS) as NetworkType[]).map(id => ({
  id,
  name: NETWORKS[id].name,
  color: NETWORKS[id].color.replace('bg-', ''), // strip tailwind prefix for inline style
}));

/** color map for inline styles */
const NETWORK_COLORS: Record<string, string> = {
  'purple-500': '#8B5CF6',
  'yellow-500': '#EAB308',
  'pink-500': '#EC4899',
  'gray-500': '#6B7280',
  'purple-400': '#A78BFA',
  'blue-400': '#60A5FA',
  'orange-500': '#F97316',
  'purple-600': '#9333EA',
  'blue-500': '#3B82F6',
  'orange-400': '#FB923C',
};

const getColorHex = (color: string): string => NETWORK_COLORS[color] ?? '#6B7280';

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
            'flex items-center gap-2 border border-border/50 bg-background/50 px-2.5 py-1.5 text-sm',
            'transition-colors duration-75 hover:bg-accent',
            className
          )}
        >
          <div
            className='h-2.5 w-2.5'
            style={{ backgroundColor: getColorHex(currentNetwork.color) }}
          />
          <span className='max-w-[80px] truncate font-medium'>{currentNetwork.name}</span>
          {currentNetwork.testnet && (
            <span className='text-[10px] text-muted-foreground'>testnet</span>
          )}
          <ChevronDownIcon className={cn('h-4 w-4 text-muted-foreground transition-transform duration-75', open && 'rotate-180')} />
        </button>
      )}
    >
      {({ close }) => (
        <div className='absolute right-0 top-full z-50 mt-1 w-52 border border-border bg-popover shadow-lg'>
          <div className='p-1'>
            <div className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
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
                  'flex w-full items-center justify-between px-2 py-1.5 text-sm transition-colors duration-75',
                  network.id === currentNetwork.id ? 'bg-accent' : 'hover:bg-accent/50'
                )}
              >
                <div className='flex items-center gap-2'>
                  <div className='h-2 w-2' style={{ backgroundColor: getColorHex(network.color) }} />
                  <span>{network.name}</span>
                  {network.testnet && (
                    <span className='text-[10px] text-muted-foreground'>testnet</span>
                  )}
                </div>
                {network.id === currentNetwork.id && (
                  <div className='h-1.5 w-1.5 bg-primary' />
                )}
              </button>
            ))}
          </div>

          {onAddNetwork && (
            <div className='border-t border-border p-1'>
              <button
                onClick={() => {
                  close();
                  onAddNetwork();
                }}
                className='flex w-full items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-75 hover:bg-accent hover:text-foreground'
              >
                <PlusIcon className='h-4 w-4' />
                <span>add network</span>
              </button>
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
};
