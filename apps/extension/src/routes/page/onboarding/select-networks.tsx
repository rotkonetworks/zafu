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
import { NETWORKS, isLaunched, ZCASH_ORCHARD_ACTIVATION } from '../../../config/networks';

interface NetworkOption {
  id: NetworkType;
  name: string;
  description: string;
  icon: string;
}

const NETWORK_DESCRIPTIONS: Record<string, { description: string; icon: string }> = {
  zcash: { description: 'private digital cash', icon: 'Z' },
  penumbra: { description: 'private defi', icon: 'P' },
  kusama: { description: 'expect chaos', icon: 'K' },
  polkadot: { description: 'multi-chain ecosystem', icon: 'D' },
  osmosis: { description: 'cosmos dex hub', icon: 'O' },
  noble: { description: 'native usdc', icon: 'U' },
  nomic: { description: 'bitcoin bridge (nBTC)', icon: 'N' },
  bitcoin: { description: 'digital gold', icon: 'B' },
  celestia: { description: 'modular data availability', icon: 'C' },
  ethereum: { description: 'smart contracts', icon: 'E' },
};

const NETWORK_OPTIONS: NetworkOption[] = (Object.keys(NETWORKS) as NetworkType[])
  .filter(id => isLaunched(id))
  .map(id => ({
    id,
    name: NETWORKS[id].name,
    ...(NETWORK_DESCRIPTIONS[id] ?? { description: '', icon: id[0]?.toUpperCase() ?? '?' }),
  }));

// only show launched networks — no "coming soon" clutter

export const SelectNetworks = () => {
  const navigate = usePageNav();
  const location = useLocation();
  const { enabledNetworks, toggleNetwork, setActiveNetwork } = useStore(state => state.keyRing);
  const [selected, setSelected] = useState<Set<NetworkType>>(new Set(enabledNetworks));
  const [zcashBirthday, setZcashBirthday] = useState('');

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
      const isSelected = selected.has(network.id);
      const wasEnabled = enabledNetworks.includes(network.id);
      if (isSelected !== wasEnabled) {
        await toggleNetwork(network.id);
      }
    }

    // set activeNetwork to the first selected network
    const firstSelected = NETWORK_OPTIONS.find(n => selected.has(n.id));
    if (firstSelected) {
      await setActiveNetwork(firstSelected.id);
    }

    // store zcash birthday - rounded to nearest 10k for privacy
    if (selected.has('zcash') && zcashBirthday) {
      const num = parseInt(zcashBirthday, 10);
      if (!isNaN(num) && num >= ZCASH_ORCHARD_ACTIVATION) {
        const rounded = Math.floor(num / 10_000) * 10_000;
        sessionStorage.setItem('pendingZcashBirthday', String(Math.max(rounded, ZCASH_ORCHARD_ACTIVATION)));
      }
    }

    navigate(PagePath.SET_PASSWORD, { state: { origin } });
  };

  const availableCount = selected.size;

  return (
    <FadeTransition>
      <BackIcon className='float-left mb-4' onClick={() => navigate(PagePath.WELCOME)} />
      <Card className={cn('p-6', 'w-[500px]')} gradient>
        <CardHeader className='items-center'>
          <CardTitle className='font-medium'>Select Networks</CardTitle>
          <CardDescription className='text-center'>
            Choose which networks you want to use with this wallet.
            You can change this later in settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex flex-col gap-3'>
            {NETWORK_OPTIONS.map(network => {
              const isSelected = selected.has(network.id);

              return (
                <button
                  key={network.id}
                  type='button'
                  onClick={() => handleToggle(network.id)}
                  className={cn(
                    'flex items-center gap-4 p-4 rounded-lg border transition-colors text-left',
                    isSelected
                      ? 'border-primary bg-primary/10'
                      : 'border-border/40 hover:border-muted-foreground/50',
                  )}
                >
                  <div
                    className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold',
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {network.icon}
                  </div>
                  <div className='flex-1'>
                    <div className='font-medium flex items-center gap-2'>
                      {network.name}
                      {NETWORKS[network.id]?.transparent && (
                        <span className='text-[10px] px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 font-medium leading-none'>
                          public
                        </span>
                      )}
                    </div>
                    <div className='text-sm text-muted-foreground'>
                      {network.description}
                    </div>
                  </div>
                  <div
                      className={cn(
                        'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors',
                        isSelected
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/50'
                      )}
                    >
                      {isSelected && <span className='i-lucide-check h-3 w-3 text-primary-foreground' />}
                    </div>
                </button>
              );
            })}
          </div>

          {/* zcash sync start height - only shown when zcash is selected */}
          {selected.has('zcash') && (
            <div className='mt-4 rounded-lg border border-border/40 p-3'>
              <div className='flex items-center gap-2 mb-2'>
                <span className='text-xs font-medium'>zcash sync start block</span>
              </div>
              <input
                type='number'
                min={ZCASH_ORCHARD_ACTIVATION}
                step='10000'
                value={zcashBirthday}
                onChange={e => setZcashBirthday(e.target.value)}
                placeholder='leave blank for new wallets'
                className='w-full bg-input border border-border/40 px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-primary'
              />
              <p className='mt-1.5 text-[10px] text-muted-foreground'>
                for existing wallets, enter an approximate block height from
                before your first transaction. rounded to nearest 10,000 for privacy.
                leave blank for new wallets.
              </p>
            </div>
          )}

          <Button
            variant='gradient'
            className='w-full mt-6'
            disabled={availableCount === 0}
            onClick={() => void handleContinue()}
          >
            continue with {availableCount} network{availableCount !== 1 ? 's' : ''}
          </Button>
        </CardContent>
      </Card>
    </FadeTransition>
  );
};
