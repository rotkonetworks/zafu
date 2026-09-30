/**
 * network sheet - pick the active network, or turn one on. Lists every
 * launched top-level network (not just the enabled ones), so a disabled
 * network still shows up with a "turn on" row instead of being invisible.
 */

import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../state';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectSetActiveNetwork,
} from '../state/keyring';
import { isIbcNetwork } from '../state/keyring/network-types';
import { getNetwork, getTopLevelNetworks } from '../config/networks';
import { PopupPath } from '../routes/popup/paths';

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
  const toggleNetwork = useStore(s => s.keyRing.toggleNetwork);
  const privacySetSetting = useStore(s => s.privacy.setSetting);
  const transparentEnabled = useStore(s => s.privacy.settings.enableTransparentBalances);

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
    await toggleNetwork(n);
    if (isIbcNetwork(n) && !transparentEnabled) {
      await privacySetSetting('enableTransparentBalances', true);
    }
    void setActiveNetwork(n);
    onOpenChange(false);
    navigate(PopupPath.INDEX);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='networks'>
      <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
        {getTopLevelNetworks().map(n => {
          const info = getNetwork(n);
          const enabled = enabledNetworks.includes(n);
          const active = activeNetwork === n;
          return (
            <div key={n} className='flex min-h-[52px] items-center gap-3 px-3.5 py-2'>
              <span
                className={cn(
                  'flex size-[18px] shrink-0 items-center justify-center border',
                  active ? 'border-zigner-gold' : 'border-surface-border',
                )}
                aria-hidden='true'
              >
                {active && <span className='size-2 bg-zigner-gold' />}
              </span>
              <span className={cn('size-2.5 shrink-0', info.color)} aria-hidden='true' />
              <button
                type='button'
                disabled={!enabled}
                onClick={() => pick(n)}
                className='min-w-0 flex-1 text-left disabled:cursor-default'
              >
                <span className='block truncate text-data text-fg-high lowercase'>
                  {info.name}
                </span>
              </button>
              {!enabled && (
                <button
                  type='button'
                  onClick={() => void turnOn(n)}
                  className='h-8 shrink-0 border border-surface-border bg-surface-elev-2 px-3 text-label text-zigner-gold transition-colors hover:bg-surface-border-soft'
                >
                  turn on
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type='button'
        onClick={() => {
          onOpenChange(false);
          navigate(PopupPath.SETTINGS_NETWORKS);
        }}
        className='mt-1 flex h-11 items-center px-1 text-left text-label text-fg-muted'
      >
        manage networks
      </button>
    </Sheet>
  );
};
