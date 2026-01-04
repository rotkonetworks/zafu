import { useState, useRef, useEffect } from 'react';
import { ChevronDownIcon, CheckIcon } from '@radix-ui/react-icons';
import { cn } from '@repo/ui/lib/utils';

export interface NetworkInfo {
  id: string;
  name: string;
  icon?: string;
  ecosystem: 'penumbra' | 'zcash' | 'polkadot' | 'bitcoin' | 'nostr';
  color?: string;
}

export const SUPPORTED_NETWORKS: NetworkInfo[] = [
  {
    id: 'penumbra-1',
    name: 'Penumbra',
    ecosystem: 'penumbra',
    color: '#7B68EE',
  },
  {
    id: 'zcash-mainnet',
    name: 'Zcash',
    ecosystem: 'zcash',
    color: '#F4B728',
  },
  {
    id: 'polkadot',
    name: 'Polkadot',
    ecosystem: 'polkadot',
    color: '#E6007A',
  },
];

interface NetworkSelectorProps {
  currentNetwork: NetworkInfo;
  onNetworkChange: (network: NetworkInfo) => void;
  networks?: NetworkInfo[];
  className?: string;
}

export const NetworkSelector = ({
  currentNetwork,
  onNetworkChange,
  networks = SUPPORTED_NETWORKS,
  className,
}: NetworkSelectorProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const groupedNetworks = networks.reduce(
    (acc, network) => {
      if (!acc[network.ecosystem]) {
        acc[network.ecosystem] = [];
      }
      acc[network.ecosystem]!.push(network);
      return acc;
    },
    {} as Record<string, NetworkInfo[]>
  );

  const ecosystemLabels: Record<string, string> = {
    penumbra: 'Penumbra',
    zcash: 'Zcash',
    polkadot: 'Polkadot',
    bitcoin: 'Bitcoin',
    nostr: 'Nostr',
  };

  return (
    <div ref={containerRef} className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-2 rounded-full border border-border/50 bg-background/50 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent',
          className
        )}
      >
        <div
          className='h-2.5 w-2.5 rounded-full'
          style={{ backgroundColor: currentNetwork.color }}
        />
        <span className='max-w-[80px] truncate'>{currentNetwork.name}</span>
        <ChevronDownIcon className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className='absolute right-0 top-full z-50 mt-2 w-48 rounded-lg border border-border bg-popover p-1 shadow-lg'>
          {Object.entries(groupedNetworks).map(([ecosystem, networkList]) => (
            <div key={ecosystem}>
              <div className='px-2 py-1.5 text-xs font-medium text-muted-foreground'>
                {ecosystemLabels[ecosystem] || ecosystem}
              </div>
              {networkList.map(network => (
                <button
                  key={network.id}
                  onClick={() => {
                    onNetworkChange(network);
                    setOpen(false);
                  }}
                  className='flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent'
                >
                  <div className='flex items-center gap-2'>
                    <div
                      className='h-2.5 w-2.5 rounded-full'
                      style={{ backgroundColor: network.color }}
                    />
                    <span>{network.name}</span>
                  </div>
                  {network.id === currentNetwork.id && (
                    <CheckIcon className='h-4 w-4 text-primary' />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
