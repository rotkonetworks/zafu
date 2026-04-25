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
  noble: { description: 'native usdc', icon: 'U' },
  cosmoshub: { description: 'cosmos hub (atom)', icon: 'A' },
  bitcoin: { description: 'digital gold', icon: 'B' },
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

/**
 * zcash block height <-> date estimation
 *
 * zcash targets 75 seconds per block. we anchor to a known block/date
 * and extrapolate. this is approximate - good enough for sync start.
 */
// anchor at orchard activation - the earliest block we allow
const ZCASH_ANCHOR_BLOCK = ZCASH_ORCHARD_ACTIVATION; // 1,687,104
const ZCASH_ANCHOR_DATE = new Date('2022-05-31T00:00:00Z');
const ZCASH_BLOCK_TIME_S = 75;

const dateToBlock = (date: Date): number => {
  const diffMs = date.getTime() - ZCASH_ANCHOR_DATE.getTime();
  const diffBlocks = Math.floor(diffMs / (ZCASH_BLOCK_TIME_S * 1000));
  return Math.max(ZCASH_ORCHARD_ACTIVATION, ZCASH_ANCHOR_BLOCK + diffBlocks);
};

const blockToDate = (block: number): Date => {
  const diffBlocks = block - ZCASH_ANCHOR_BLOCK;
  const diffMs = diffBlocks * ZCASH_BLOCK_TIME_S * 1000;
  return new Date(ZCASH_ANCHOR_DATE.getTime() + diffMs);
};

const formatDateInput = (date: Date): string => date.toISOString().split('T')[0]!;

export const SelectNetworks = () => {
  const navigate = usePageNav();
  const location = useLocation();
  const { enabledNetworks, toggleNetwork, setActiveNetwork } = useStore(state => state.keyRing);
  const [selected, setSelected] = useState<Set<NetworkType>>(new Set(enabledNetworks));
  const [zcashBirthday, setZcashBirthday] = useState('');
  const [zcashDate, setZcashDate] = useState('');
  const [inputMode, setInputMode] = useState<'date' | 'block'>('date');

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

    // store zcash birthday - round down to nearest 10k, then subtract
    // one more 10k to guarantee we start before the actual date
    // (the date-to-block estimate can drift a few thousand blocks ahead)
    if (selected.has('zcash') && zcashBirthday) {
      const num = parseInt(zcashBirthday, 10);
      if (!isNaN(num) && num >= ZCASH_ORCHARD_ACTIVATION) {
        const rounded = Math.floor(num / 10_000) * 10_000 - 10_000;
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
                      ? 'border-zigner-gold bg-primary/10'
                      : 'border-border-soft hover:border-muted-foreground/50',
                  )}
                >
                  <div
                    className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold',
                      isSelected
                        ? 'bg-zigner-gold text-zigner-dark'
                        : 'bg-elev-2 text-fg-muted'
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
                    <div className='text-sm text-fg-muted'>
                      {network.description}
                    </div>
                  </div>
                  <div
                      className={cn(
                        'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors',
                        isSelected
                          ? 'border-zigner-gold bg-zigner-gold'
                          : 'border-muted-foreground/50'
                      )}
                    >
                      {isSelected && <span className='i-lucide-check h-3 w-3 text-zigner-dark' />}
                    </div>
                </button>
              );
            })}
          </div>

          {/* zcash sync start - only shown when zcash is selected */}
          {selected.has('zcash') && (
            <div className='mt-4 rounded-lg border border-border-soft p-3'>
              <div className='flex items-center justify-between mb-2'>
                <span className='text-xs font-medium'>wallet birthday</span>
                <button
                  type='button'
                  onClick={() => setInputMode(inputMode === 'date' ? 'block' : 'date')}
                  className='text-[10px] text-fg-muted hover:text-fg-high transition-colors'
                >
                  {inputMode === 'date' ? 'enter block instead' : 'enter date instead'}
                </button>
              </div>

              {inputMode === 'date' ? (
                <input
                  type='date'
                  min={formatDateInput(blockToDate(ZCASH_ORCHARD_ACTIVATION))}
                  max={formatDateInput(new Date())}
                  value={zcashDate}
                  onChange={e => {
                    setZcashDate(e.target.value);
                    if (e.target.value) {
                      setZcashBirthday(String(dateToBlock(new Date(e.target.value + 'T00:00:00Z'))));
                    } else {
                      setZcashBirthday('');
                    }
                  }}
                  className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
                />
              ) : (
                <input
                  type='number'
                  min={ZCASH_ORCHARD_ACTIVATION}
                  step='10000'
                  value={zcashBirthday}
                  onChange={e => {
                    setZcashBirthday(e.target.value);
                    const num = parseInt(e.target.value, 10);
                    if (!isNaN(num) && num >= ZCASH_ORCHARD_ACTIVATION) {
                      setZcashDate(formatDateInput(blockToDate(num)));
                    }
                  }}
                  placeholder='leave blank for new wallets'
                  className='w-full bg-input border border-border-soft px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-zigner-gold'
                />
              )}

              {zcashBirthday && (
                <p className='mt-1.5 text-[10px] text-fg-muted'>
                  ~block {Number(zcashBirthday).toLocaleString()}
                  {zcashDate && ` (~${zcashDate})`}
                </p>
              )}
              <p className='mt-1 text-[10px] text-fg-muted'>
                for existing wallets, pick the approximate date you created the wallet.
                leave blank for new wallets. rounded for privacy.
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
