/**
 * network sheet - pick the active network, or turn one on. Lists every
 * launched top-level network (not just the enabled ones), so a disabled
 * network still shows up with a "turn on" row instead of being invisible.
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { useStore } from '../state';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectSetActiveNetwork,
} from '../state/keyring';
import { useEnableNetwork } from '../hooks/enable-network';
import { getNetwork, getTopLevelNetworks } from '../config/networks';
import { PopupPath } from '../routes/popup/paths';

/** one line per network, so the pools read apart at a glance */
export const NETWORK_BLURB: Partial<Record<string, string>> = {
  zcash: 'encrypted money',
  penumbra: 'private defi',
};

export const NetworkSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const enable = useEnableNetwork();

  const pick = (n: (typeof enabledNetworks)[number]) => {
    onOpenChange(false);
    if (n !== activeNetwork) {
      void setActiveNetwork(n);
      // always land on home - the previous sub-page may not exist on the
      // newly selected network
      navigate(PopupPath.INDEX);
    }
  };

  const turnOn = async (n: (typeof enabledNetworks)[number]) => {
    await enable(n);
    onOpenChange(false);
    navigate(PopupPath.INDEX);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='networks' className='gap-0 px-3 pb-4'>
      {getTopLevelNetworks().map(n => {
        const info = getNetwork(n);
        const enabled = enabledNetworks.includes(n);
        const active = activeNetwork === n;
        return (
          <div key={n} className='flex h-[60px] items-center gap-3.5 px-2'>
            <button
              type='button'
              disabled={!enabled}
              onClick={() => pick(n)}
              aria-label={`use ${info.name}`}
              className='flex min-w-0 flex-1 items-center gap-3.5 text-left disabled:cursor-default'
            >
              <span
                className={cn(
                  'flex size-[18px] shrink-0 items-center justify-center',
                  enabled && 'border',
                  active ? 'border-zigner-gold' : 'border-surface-border',
                )}
                aria-hidden='true'
              >
                {active && <span className='size-2 bg-zigner-gold' />}
              </span>
              <span className={cn('size-2.5 shrink-0', info.color)} aria-hidden='true' />
              <span className='flex min-w-0 flex-col gap-[3px]'>
                <Clipped className='text-[15px] text-fg-high lowercase'>{info.name}</Clipped>
                {NETWORK_BLURB[n] && (
                  <Clipped className='text-[11px] text-fg-muted'>{NETWORK_BLURB[n]}</Clipped>
                )}
              </span>
            </button>
            {!enabled && (
              <Button
                variant='secondary'
                size='sm'
                className='h-8 border-surface-border px-3 text-zigner-gold'
                onClick={() => void turnOn(n)}
              >
                turn on
              </Button>
            )}
          </div>
        );
      })}
      <button
        type='button'
        onClick={() => {
          onOpenChange(false);
          navigate(PopupPath.SETTINGS_DEVICES);
        }}
        className='mt-1.5 flex h-11 items-center border-t border-border-soft px-2 text-left text-label text-fg-muted'
      >
        manage networks
      </button>
    </Sheet>
  );
};
