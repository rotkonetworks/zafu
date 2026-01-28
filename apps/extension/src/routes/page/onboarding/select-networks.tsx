import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { BackIcon } from '@repo/ui/components/ui/icons/back-icon';
import { Button } from '@repo/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/ui/card';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { cn } from '@repo/ui/lib/utils';
import { usePageNav } from '../../../utils/navigate';
import { PagePath } from '../paths';
import { useStore } from '../../../state';
import { NetworkType } from '../../../state/keyring';
import { getSeedPhraseOrigin } from './password/utils';

interface NetworkOption {
  id: NetworkType;
  name: string;
  description: string;
  icon: string;
  comingSoon?: boolean;
}

const NETWORK_OPTIONS: NetworkOption[] = [
  {
    id: 'zcash',
    name: 'Zcash',
    description: 'private digital cash',
    icon: 'Z',
  },
  {
    id: 'penumbra',
    name: 'Penumbra',
    description: 'private defi on cosmos',
    icon: 'P',
  },
  {
    id: 'kusama',
    name: 'Kusama',
    description: 'expect chaos',
    icon: 'K',
  },
  {
    id: 'polkadot',
    name: 'Polkadot',
    description: 'multi-chain ecosystem',
    icon: 'D',
  },
  {
    id: 'osmosis',
    name: 'Osmosis',
    description: 'cosmos dex hub',
    icon: 'O',
  },
  {
    id: 'noble',
    name: 'Noble',
    description: 'native usdc',
    icon: 'U',
  },
  {
    id: 'nomic',
    name: 'Nomic',
    description: 'bitcoin bridge (nBTC)',
    icon: 'N',
  },
  {
    id: 'bitcoin',
    name: 'Bitcoin',
    description: 'digital gold',
    icon: 'B',
    comingSoon: true,
  },
];

export const SelectNetworks = () => {
  const navigate = usePageNav();
  const location = useLocation();
  const { enabledNetworks, toggleNetwork } = useStore(state => state.keyRing);
  const [selected, setSelected] = useState<Set<NetworkType>>(new Set(enabledNetworks));

  // get origin from incoming state, default to NEWLY_GENERATED
  const origin = getSeedPhraseOrigin(location);

  const handleToggle = (network: NetworkType) => {
    const newSelected = new Set(selected);
    if (newSelected.has(network)) {
      newSelected.delete(network);
    } else {
      newSelected.add(network);
    }
    setSelected(newSelected);
  };

  const handleContinue = async () => {
    // sync selected networks to store
    for (const network of NETWORK_OPTIONS) {
      if (network.comingSoon) continue;
      const isSelected = selected.has(network.id);
      const wasEnabled = enabledNetworks.includes(network.id);
      if (isSelected !== wasEnabled) {
        await toggleNetwork(network.id);
      }
    }
    // pass origin state to password page
    navigate(PagePath.SET_PASSWORD, { state: { origin } });
  };

  // only count networks that are actually available (not comingSoon)
  const availableNetworks = NETWORK_OPTIONS.filter(n => !n.comingSoon).map(n => n.id);
  const availableCount = [...selected].filter(id => availableNetworks.includes(id)).length;

  return (
    <FadeTransition>
      <BackIcon className='float-left mb-4' onClick={() => navigate(PagePath.WELCOME)} />
      <Card className={cn('p-6', 'w-[500px]')} gradient>
        <CardHeader className='items-center'>
          <CardTitle className='font-semibold'>Select Networks</CardTitle>
          <CardDescription className='text-center'>
            Choose which networks you want to use with this wallet.
            You can change this later in settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex flex-col gap-3'>
            {NETWORK_OPTIONS.map(network => {
              const isSelected = selected.has(network.id);
              const isDisabled = network.comingSoon;

              return (
                <button
                  key={network.id}
                  type='button'
                  disabled={isDisabled}
                  onClick={() => handleToggle(network.id)}
                  className={cn(
                    'flex items-center gap-4 p-4 rounded-lg border transition-all text-left',
                    isSelected && !isDisabled
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-muted-foreground/50',
                    isDisabled && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <div
                    className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold',
                      isSelected && !isDisabled
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {network.icon}
                  </div>
                  <div className='flex-1'>
                    <div className='font-medium flex items-center gap-2'>
                      {network.name}
                      {network.comingSoon && (
                        <span className='text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground'>
                          coming soon
                        </span>
                      )}
                    </div>
                    <div className='text-sm text-muted-foreground'>
                      {network.description}
                    </div>
                  </div>
                  {!isDisabled && (
                    <div
                      className={cn(
                        'w-5 h-5 rounded border-2 flex items-center justify-center',
                        isSelected
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground'
                      )}
                    >
                      {isSelected && (
                        <svg
                          className='w-3 h-3 text-primary-foreground'
                          fill='none'
                          viewBox='0 0 24 24'
                          stroke='currentColor'
                        >
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={3}
                            d='M5 13l4 4L19 7'
                          />
                        </svg>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <Button
            variant='gradient'
            className='w-full mt-6'
            disabled={availableCount === 0}
            onClick={() => void handleContinue()}
          >
            Continue with {availableCount} network{availableCount !== 1 ? 's' : ''}
          </Button>
        </CardContent>
      </Card>
    </FadeTransition>
  );
};
