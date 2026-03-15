/**
 * settings page for managing enabled networks + per-network endpoints
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectEnabledNetworks, selectSetActiveNetwork, type NetworkType } from '../../../state/keyring';
import { isIbcNetwork } from '../../../state/keyring/network-types';
import { networksSelector, type NetworkId } from '../../../state/networks';
import { NETWORKS, LAUNCHED_NETWORKS } from '../../../config/networks';
import { cn } from '@repo/ui/lib/utils';
import { SettingsScreen } from './settings-screen';
import { PopupPath } from '../paths';

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

export const SettingsNetworks = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const toggleNetwork = useStore(state => state.keyRing.toggleNetwork);
  const privacySetSetting = useStore(state => state.privacy.setSetting);
  const transparentEnabled = useStore(state => state.privacy.settings.enableTransparentBalances);
  const { networks: networkState, setNetworkEndpoint } = useStore(networksSelector);

  const [expandedNetwork, setExpandedNetwork] = useState<NetworkType | null>(null);
  const [editingEndpoint, setEditingEndpoint] = useState('');
  const [saving, setSaving] = useState(false);

  const handleToggle = async (network: NetworkType) => {
    const wasEnabled = enabledNetworks.includes(network);
    await toggleNetwork(network);
    if (!wasEnabled && isIbcNetwork(network) && !transparentEnabled) {
      await privacySetSetting('enableTransparentBalances', true);
    }
    // if enabling, auto-activate it (user probably wants to use it)
    if (!wasEnabled) {
      void setActiveNetwork(network);
    }
  };

  const handleExpandToggle = (networkId: NetworkType) => {
    if (expandedNetwork === networkId) {
      setExpandedNetwork(null);
    } else {
      setExpandedNetwork(networkId);
      const state = networkState[networkId as NetworkId];
      setEditingEndpoint(state?.endpoint ?? '');
    }
  };

  const handleSaveEndpoint = async (networkId: NetworkType) => {
    setSaving(true);
    try {
      await setNetworkEndpoint(networkId as NetworkId, editingEndpoint);
      setExpandedNetwork(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsScreen title='networks' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-1'>
        {LAUNCHED_NETWORKS.map(networkId => {
          const network = NETWORKS[networkId];
          const isEnabled = enabledNetworks.includes(networkId);
          const isActive = activeNetwork === networkId;
          const isExpanded = expandedNetwork === networkId;
          const state = networkState[networkId as NetworkId];

          return (
            <div key={networkId} className={cn(
              'rounded-lg border overflow-hidden transition-colors',
              isActive ? 'border-primary/60' : 'border-border/40',
            )}>
              {/* network row */}
              <div className='flex items-center p-3'>
                {/* name — click to set active (if enabled) */}
                <button
                  onClick={() => {
                    if (isEnabled) void setActiveNetwork(networkId);
                    else void handleToggle(networkId);
                  }}
                  className='flex flex-1 items-center gap-3'
                >
                  <div
                    className={cn('h-3 w-3 rounded-full', isActive && 'ring-2 ring-primary/40 ring-offset-1 ring-offset-background')}
                    style={{ backgroundColor: getColorHex(network.color) }}
                  />
                  <span className={cn('font-medium text-sm', !isEnabled && 'text-muted-foreground')}>{network.name}</span>
                  {isActive && (
                    <span className='text-[10px] px-1.5 py-0.5 rounded-md bg-primary/15 text-primary font-medium leading-none'>
                      active
                    </span>
                  )}
                  {network.transparent && (
                    <span className='text-[10px] px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 font-medium leading-none'>
                      public
                    </span>
                  )}
                </button>

                <div className='flex items-center gap-2'>
                  {/* endpoint expand button — only for enabled networks */}
                  {isEnabled && (
                    <button
                      onClick={() => handleExpandToggle(networkId)}
                      className={cn(
                        'p-1 transition-colors',
                        isExpanded ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                      )}
                      title='configure endpoint'
                    >
                      <span className='i-lucide-settings-2 h-3.5 w-3.5' />
                    </button>
                  )}

                  {/* checkbox — toggles enabled/disabled */}
                  <button
                    onClick={() => void handleToggle(networkId)}
                    className={cn(
                      'h-5 w-5 rounded border-2 flex items-center justify-center transition-colors',
                      isEnabled ? 'border-primary bg-primary' : 'border-muted-foreground/50'
                    )}
                  >
                    {isEnabled && <span className='i-lucide-check h-3 w-3 text-primary-foreground' />}
                  </button>
                </div>
              </div>

              {/* endpoint config — expanded */}
              {isExpanded && isEnabled && (
                <div className='border-t border-border/40 p-3 bg-muted/10'>
                  <div className='text-[10px] text-muted-foreground mb-1'>endpoint</div>
                  <div className='flex gap-2'>
                    <input
                      type='text'
                      value={editingEndpoint}
                      onChange={e => setEditingEndpoint(e.target.value)}
                      placeholder={state?.endpoint ?? 'https://...'}
                      className='flex-1 bg-input border border-border/40 px-2 py-1.5 text-xs font-mono focus:border-primary/50 focus:outline-none'
                    />
                    <button
                      onClick={() => void handleSaveEndpoint(networkId)}
                      disabled={saving}
                      className='px-3 py-1.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50'
                    >
                      {saving ? '...' : 'save'}
                    </button>
                  </div>
                  {state?.syncDescription && (
                    <p className='text-[10px] text-muted-foreground mt-1.5'>{state.syncDescription}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SettingsScreen>
  );
};

export default SettingsNetworks;
