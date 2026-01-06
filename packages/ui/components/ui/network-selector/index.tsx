'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { cn } from '../../../lib/utils';
import { ChevronDownIcon, CheckIcon } from '@radix-ui/react-icons';

export type NetworkType = 'penumbra' | 'zcash' | 'polkadot' | 'cosmos';

export interface NetworkOption {
  type: NetworkType;
  name: string;
  icon: string;
  enabled: boolean;
}

export const DEFAULT_NETWORKS: NetworkOption[] = [
  { type: 'penumbra', name: 'Penumbra', icon: '🔴', enabled: true },
  { type: 'zcash', name: 'Zcash', icon: '💛', enabled: true },
  { type: 'polkadot', name: 'Polkadot', icon: '🔵', enabled: false },
  { type: 'cosmos', name: 'Cosmos', icon: '⚛️', enabled: false },
];

export interface NetworkSelectorProps {
  value: NetworkType;
  onChange: (network: NetworkType) => void;
  networks?: NetworkOption[];
  className?: string;
}

export const NetworkSelector = ({
  value,
  onChange,
  networks = DEFAULT_NETWORKS,
  className,
}: NetworkSelectorProps) => {
  const [open, setOpen] = React.useState(false);
  const selectedNetwork = networks.find((n) => n.type === value) ?? networks[0];

  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(v) => onChange(v as NetworkType)}
      open={open}
      onOpenChange={setOpen}
    >
      <SelectPrimitive.Trigger
        className={cn(
          'flex items-center gap-2 rounded-lg border border-white/10 bg-background/50 px-3 py-2',
          'text-sm font-medium text-foreground',
          'hover:bg-background/70 transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-primary/50',
          className,
        )}
      >
        <span className='text-lg'>{selectedNetwork?.icon}</span>
        <SelectPrimitive.Value>
          <span>{selectedNetwork?.name}</span>
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon
            className={cn('h-4 w-4 opacity-50 transition-transform', open && 'rotate-180')}
          />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={cn(
            'relative z-50 min-w-[180px] overflow-hidden rounded-lg border border-white/10',
            'bg-background/95 backdrop-blur-lg shadow-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          )}
          position='popper'
          sideOffset={4}
        >
          <SelectPrimitive.Viewport className='p-1'>
            {networks.map((network) => (
              <SelectPrimitive.Item
                key={network.type}
                value={network.type}
                disabled={!network.enabled}
                className={cn(
                  'relative flex cursor-pointer items-center gap-2 rounded-md px-3 py-2',
                  'text-sm font-medium outline-none',
                  'data-[highlighted]:bg-white/10',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
                  'transition-colors',
                )}
              >
                <span className='text-lg'>{network.icon}</span>
                <SelectPrimitive.ItemText>{network.name}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className='ml-auto'>
                  <CheckIcon className='h-4 w-4' />
                </SelectPrimitive.ItemIndicator>
                {!network.enabled && (
                  <span className='ml-auto text-xs text-muted-foreground'>Soon</span>
                )}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
};
