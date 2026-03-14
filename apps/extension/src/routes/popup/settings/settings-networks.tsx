/**
 * settings page for managing enabled networks
 */

import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon, CheckIcon, PlusIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { selectEnabledNetworks, type NetworkType } from '../../../state/keyring';
import { isIbcNetwork } from '../../../state/keyring/network-types';
import { NETWORKS } from '../../../config/networks';
import { cn } from '@repo/ui/lib/utils';

/** color map for network indicators */
const NETWORK_COLORS: Record<string, string> = {
  'bg-purple-500': '#8B5CF6',
  'bg-yellow-500': '#EAB308',
  'bg-pink-500': '#EC4899',
  'bg-gray-500': '#6B7280',
  'bg-purple-400': '#A78BFA',
  'bg-blue-400': '#60A5FA',
  'bg-orange-500': '#F97316',
  'bg-purple-600': '#9333EA',
  'bg-blue-500': '#3B82F6',
  'bg-orange-400': '#FB923C',
};

const getColorHex = (color: string): string =>
  NETWORK_COLORS[color] ?? '#6B7280';

/** networks that are fully implemented */
const READY_NETWORKS: NetworkType[] = ['penumbra', 'zcash', 'osmosis', 'noble', 'nomic', 'celestia'];

export const SettingsNetworks = () => {
  const navigate = useNavigate();
  const enabledNetworks = useStore(selectEnabledNetworks);
  const toggleNetwork = useStore(state => state.keyRing.toggleNetwork);
  const privacySetSetting = useStore(state => state.privacy.setSetting);
  const transparentEnabled = useStore(state => state.privacy.settings.enableTransparentBalances);

  const handleToggle = async (network: NetworkType) => {
    const wasEnabled = enabledNetworks.includes(network);
    await toggleNetwork(network);
    // auto-enable transparent balance fetching when enabling (not disabling) an IBC chain
    if (!wasEnabled && isIbcNetwork(network) && !transparentEnabled) {
      await privacySetSetting('enableTransparentBalances', true);
    }
  };

  return (
    <div className='flex flex-col'>
      <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={() => navigate(-1)}
          className='text-muted-foreground transition-colors hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium'>manage networks</h1>
      </div>

      <div className='flex flex-col gap-4 p-4'>
        {/* ready networks */}
        <div>
          <div className='mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
            available
          </div>
          <div className='flex flex-col gap-1'>
            {READY_NETWORKS.map(networkId => {
              const network = NETWORKS[networkId];
              const isEnabled = enabledNetworks.includes(networkId);

              return (
                <button
                  key={networkId}
                  onClick={() => void handleToggle(networkId)}
                  className={cn(
                    'flex items-center justify-between p-3 border border-border/40 transition-colors',
                    isEnabled ? 'bg-primary/5 border-primary/30' : 'hover:bg-muted/30'
                  )}
                >
                  <div className='flex items-center gap-3'>
                    <div
                      className='h-3 w-3 rounded-full'
                      style={{ backgroundColor: getColorHex(network.color) }}
                    />
                    <span className='font-medium'>{network.name}</span>
                  </div>
                  <div
                    className={cn(
                      'h-5 w-5 rounded border-2 flex items-center justify-center transition-colors',
                      isEnabled ? 'border-primary bg-primary' : 'border-muted-foreground/50'
                    )}
                  >
                    {isEnabled && <CheckIcon className='h-3 w-3 text-primary-foreground' />}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* add custom chain - placeholder */}
        <button
          disabled
          className='flex items-center justify-center gap-2 p-3 border border-dashed border-border/60 text-muted-foreground opacity-50 cursor-not-allowed'
        >
          <PlusIcon className='h-4 w-4' />
          <span className='text-sm'>add custom chain (coming soon)</span>
        </button>
      </div>
    </div>
  );
};

export default SettingsNetworks;
