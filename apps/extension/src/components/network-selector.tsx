import { useState, useRef, useEffect } from 'react';
import { ChevronDownIcon, PlusIcon } from '@radix-ui/react-icons';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../state';
import { keyRingSelector, NetworkType } from '../state/keyring';

export type Ecosystem = 'penumbra' | 'zcash' | 'polkadot' | 'bitcoin' | 'nostr';

export interface NetworkInfo {
  id: string;
  name: string;
  icon?: string;
  ecosystem: Ecosystem;
  color?: string;
  testnet?: boolean;
}

export const SUPPORTED_NETWORKS: NetworkInfo[] = [
  {
    id: 'penumbra-1',
    name: 'penumbra',
    ecosystem: 'penumbra',
    color: '#7B68EE',
  },
  {
    id: 'zcash-mainnet',
    name: 'zcash',
    ecosystem: 'zcash',
    color: '#F4B728',
  },
  {
    id: 'polkadot',
    name: 'polkadot',
    ecosystem: 'polkadot',
    color: '#E6007A',
  },
  {
    id: 'bitcoin-mainnet',
    name: 'bitcoin',
    ecosystem: 'bitcoin',
    color: '#F7931A',
  },
  {
    id: 'nostr',
    name: 'nostr',
    ecosystem: 'nostr',
    color: '#8B5CF6',
  },
];

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
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { enabledNetworks, toggleNetwork } = useStore(keyRingSelector);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // only show enabled networks
  const activeNetworks = networks.filter(n =>
    enabledNetworks.includes(n.ecosystem as NetworkType)
  );

  return (
    <div ref={containerRef} className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-2 border border-border/50 bg-background/50 px-2.5 py-1.5 text-sm',
          'transition-colors duration-75 hover:bg-accent',
          className
        )}
      >
        <div
          className='h-2.5 w-2.5'
          style={{ backgroundColor: currentNetwork.color }}
        />
        <span className='max-w-[80px] truncate font-medium'>{currentNetwork.name}</span>
        {currentNetwork.testnet && (
          <span className='text-[10px] text-muted-foreground'>testnet</span>
        )}
        <ChevronDownIcon className={cn('h-4 w-4 text-muted-foreground transition-transform duration-75', open && 'rotate-180')} />
      </button>

      {open && (
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
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between px-2 py-1.5 text-sm transition-colors duration-75',
                  network.id === currentNetwork.id ? 'bg-accent' : 'hover:bg-accent/50'
                )}
              >
                <div className='flex items-center gap-2'>
                  <div
                    className='h-2 w-2'
                    style={{ backgroundColor: network.color }}
                  />
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

          {/* manage networks */}
          <div className='border-t border-border p-1'>
            <div className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
              toggle networks
            </div>
            {networks.map(network => {
              const isEnabled = enabledNetworks.includes(network.ecosystem as NetworkType);
              return (
                <button
                  key={`toggle-${network.id}`}
                  onClick={() => void toggleNetwork(network.ecosystem as NetworkType)}
                  className='flex w-full items-center justify-between px-2 py-1.5 text-sm transition-colors duration-75 hover:bg-accent/50'
                >
                  <div className='flex items-center gap-2'>
                    <div
                      className='h-2 w-2'
                      style={{ backgroundColor: network.color, opacity: isEnabled ? 1 : 0.3 }}
                    />
                    <span className={isEnabled ? '' : 'text-muted-foreground'}>{network.name}</span>
                  </div>
                  <div className={cn(
                    'h-3 w-3 border border-border flex items-center justify-center',
                    isEnabled && 'bg-primary border-primary'
                  )}>
                    {isEnabled && <span className='text-[8px] text-primary-foreground'>✓</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {onAddNetwork && (
            <div className='border-t border-border p-1'>
              <button
                onClick={() => {
                  setOpen(false);
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
    </div>
  );
};
