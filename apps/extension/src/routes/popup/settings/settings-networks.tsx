/**
 * settings page for managing enabled networks + per-network endpoints
 */

import { useState } from 'react';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectEnabledNetworks, selectSetActiveNetwork, type NetworkType } from '../../../state/keyring';
import { isIbcNetwork } from '../../../state/keyring/network-types';
import { networksSelector, type NetworkId, type MemoSyncStrategy, type MempoolWatchSetting } from '../../../state/networks';
import { backendTrustDescription, type ZcashBackend } from '../../../state/keyring/zcash-backend';
import { isMempoolWatchEnabled } from '../../../services/mempool-watch/strategy';
import {
  ZCASH_MAINNET_ENDPOINTS,
  findPresetByUrl,
  groupPresetsByRegion,
  type RpcEndpointRegion,
} from '../../../config/zcash-endpoints';
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
  const { networks: networkState, setNetworkEndpoint, setMemoSyncStrategy, setMempoolWatch, setZcashBackend } = useStore(networksSelector);

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
              isActive ? 'border-primary/60' : 'border-border-soft',
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
                  <span className={cn('font-medium text-sm', !isEnabled && 'text-fg-muted')}>{network.name}</span>
                  {isActive && (
                    <span className='text-[10px] px-1.5 py-0.5 rounded-md bg-primary/15 text-zigner-gold font-medium leading-none'>
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
                        isExpanded ? 'text-fg' : 'text-fg-muted hover:text-fg-high'
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
                      isEnabled ? 'border-zigner-gold bg-zigner-gold' : 'border-muted-foreground/50'
                    )}
                  >
                    {isEnabled && <span className='i-lucide-check h-3 w-3 text-zigner-dark' />}
                  </button>
                </div>
              </div>

              {/* endpoint config — expanded */}
              {isExpanded && isEnabled && (
                <div className='border-t border-border-soft p-3 bg-elev-2/10'>
                  {/* zcash-specific preset picker — surfaces the same set the
                      user saw at onboarding so they don't have to type a URL
                      to switch to a known-good fallback. Free-text input
                      stays below for custom endpoints. */}
                  {networkId === 'zcash' && (
                    <ZcashEndpointPicker
                      currentUrl={editingEndpoint}
                      onPick={async (url) => {
                        // Persist directly via the store action, bypassing
                        // the editingEndpoint useState (which is async). Then
                        // reflect into the input so the user sees the
                        // selection committed. Close the expanded panel as
                        // confirmation, same as the manual save path.
                        setSaving(true);
                        try {
                          await setNetworkEndpoint('zcash', url);
                          setEditingEndpoint(url);
                          setExpandedNetwork(null);
                        } finally {
                          setSaving(false);
                        }
                      }}
                    />
                  )}
                  <div className='text-[10px] text-fg-muted mb-1'>
                    {networkId === 'zcash' ? 'or custom endpoint' : 'endpoint'}
                  </div>
                  <div className='flex gap-2'>
                    <input
                      type='text'
                      value={editingEndpoint}
                      onChange={e => setEditingEndpoint(e.target.value)}
                      placeholder={state?.endpoint ?? 'https://...'}
                      className='flex-1 bg-input border border-border-soft px-2 py-1.5 text-xs font-mono focus:border-primary/50 focus:outline-none'
                    />
                    <button
                      onClick={() => void handleSaveEndpoint(networkId)}
                      disabled={saving}
                      className='px-3 py-1.5 text-xs bg-zigner-gold text-zigner-dark hover:bg-primary/90 transition-colors disabled:opacity-50'
                    >
                      {saving ? '...' : 'save'}
                    </button>
                  </div>
                  {state?.syncDescription && (
                    <p className='text-[10px] text-fg-muted mt-1.5'>{state.syncDescription}</p>
                  )}

                  {networkId === 'zcash' && (() => {
                    const zcashState = state as {
                      memoSyncStrategy?: MemoSyncStrategy;
                      mempoolWatch?: MempoolWatchSetting;
                      backend?: ZcashBackend;
                    } | undefined;
                    const backend: ZcashBackend = zcashState?.backend ?? 'zidecar';
                    return (
                      <>
                        <BackendTrustBadge
                          backend={backend}
                          onChange={(b) => void setZcashBackend(b)}
                        />
                        <MemoSyncStrategyPicker
                          value={zcashState?.memoSyncStrategy ?? 'private'}
                          onChange={(s) => void setMemoSyncStrategy('zcash', s)}
                        />
                        <MempoolWatchToggle
                          value={zcashState?.mempoolWatch ?? 'off'}
                          backend={backend}
                          onChange={(s) => void setMempoolWatch('zcash', s)}
                        />
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SettingsScreen>
  );
};

interface MemoSyncStrategyPickerProps {
  readonly value: MemoSyncStrategy;
  readonly onChange: (strategy: MemoSyncStrategy) => void;
}

const STRATEGY_OPTIONS: ReadonlyArray<{
  id: MemoSyncStrategy;
  label: string;
  hint: string;
}> = [
  {
    id: 'private',
    label: 'private',
    hint: 'bucket + 2× decoy + shuffle. recommended default.',
  },
  {
    id: 'fast',
    label: 'fast',
    hint: 'bucket only, no decoys. faster sync but server can correlate buckets ↔ wallet.',
  },
  {
    id: 'paranoid',
    label: 'paranoid',
    hint: 'bucket + 5× decoy + shuffle. slower; strongest decoy ratio.',
  },
];

const MemoSyncStrategyPicker = ({ value, onChange }: MemoSyncStrategyPickerProps) => (
  <div className='mt-3 pt-3 border-t border-border-soft'>
    <div className='text-[10px] text-fg-muted mb-1.5'>memo sync privacy</div>
    <div className='flex flex-col gap-1'>
      {STRATEGY_OPTIONS.map(opt => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type='button'
            onClick={() => onChange(opt.id)}
            className={cn(
              'flex items-start gap-2 p-2 rounded border text-left transition-colors',
              selected ? 'border-primary/60 bg-primary/5' : 'border-border-soft hover:border-border',
            )}
          >
            <div className={cn(
              'mt-0.5 h-3 w-3 rounded-full border-2 flex-shrink-0',
              selected ? 'border-zigner-gold bg-zigner-gold' : 'border-muted-foreground/50',
            )} />
            <div className='flex-1'>
              <div className='text-xs font-medium leading-none mb-0.5'>{opt.label}</div>
              <div className='text-[10px] text-fg-muted leading-snug'>{opt.hint}</div>
            </div>
          </button>
        );
      })}
    </div>
    {value === 'fast' && (
      <div className='mt-2 p-2 rounded border border-amber-500/30 bg-amber-500/5'>
        <div className='text-[10px] text-amber-500 leading-snug'>
          fast mode skips decoy buckets — the server learns which 100-block ranges your wallet cares about.
          memos themselves remain encrypted.
        </div>
      </div>
    )}
  </div>
);

interface MempoolWatchToggleProps {
  readonly value: MempoolWatchSetting;
  readonly backend: ZcashBackend;
  readonly onChange: (setting: MempoolWatchSetting) => void;
}

const MempoolWatchToggle = ({ value, backend, onChange }: MempoolWatchToggleProps) => {
  // mempool watch requires zidecar's compact-action mempool stream.
  // lightwalletd returns raw txs we can't trial-decrypt without a heavier
  // parser, so the toggle is meaningless on that backend. show it as
  // disabled with a clear hint instead of silently ignoring clicks.
  // Same gate the worker + hook use. Centralized so UI can't drift.
  const available = backend === 'zidecar';
  const enabled = available && isMempoolWatchEnabled(value, backend);
  return (
    <div className='mt-3 pt-3 border-t border-border-soft'>
      <button
        type='button'
        disabled={!available}
        onClick={() => available && onChange(enabled ? 'off' : 'on')}
        className={cn(
          'flex items-start gap-2 w-full text-left',
          !available && 'opacity-50 cursor-not-allowed',
        )}
      >
        <div className={cn(
          'mt-0.5 h-4 w-7 rounded-full border-2 flex-shrink-0 relative transition-colors',
          enabled ? 'border-zigner-gold bg-zigner-gold/30' : 'border-muted-foreground/50',
        )}>
          <div className={cn(
            'absolute top-0 h-3 w-3 rounded-full bg-zigner-gold transition-all',
            enabled ? 'left-3' : 'left-0',
          )} />
        </div>
        <div className='flex-1'>
          <div className='text-xs font-medium leading-none mb-0.5'>
            instant pending (mempool watch)
          </div>
          <div className='text-[10px] text-fg-muted leading-snug'>
            {available
              ? "your indexer learns when you're online."
              : 'unavailable on lightwalletd backend — switch to a zidecar endpoint.'}
          </div>
        </div>
      </button>
      {enabled && (
        <div className='mt-2 p-2 rounded border border-amber-500/30 bg-amber-500/5'>
          <div className='text-[10px] text-amber-500 leading-snug'>
            polling at ~10s ± jitter. server cannot see which mempool tx is yours
            (trial-decrypt is local), but it sees a continuous "online" signal from
            your wallet.
          </div>
        </div>
      )}
    </div>
  );
};

interface BackendTrustBadgeProps {
  readonly backend: ZcashBackend;
  readonly onChange: (backend: ZcashBackend) => void;
}

/**
 * Surfaces the trust delta between zidecar (trustless: Ligerito + NOMT
 * proofs verified locally) and lightwalletd (trusted: takes the server's
 * word). Without this, users on third-party endpoints get silently
 * downgraded verification with no UI signal.
 */
const BackendTrustBadge = ({ backend, onChange }: BackendTrustBadgeProps) => {
  const trust = backendTrustDescription(backend);
  const isTrustless = backend === 'zidecar';
  return (
    <div className='mt-3 pt-3 border-t border-border-soft'>
      <div className='flex items-start gap-2'>
        <span className={cn(
          'mt-0.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium',
          isTrustless ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400',
        )}>
          {trust.label}
        </span>
        <div className='flex-1'>
          <div className='text-xs font-medium leading-none mb-0.5'>
            sync backend: {backend}
          </div>
          <div className='text-[10px] text-fg-muted leading-snug'>{trust.summary}</div>
        </div>
      </div>
      <button
        type='button'
        onClick={() => onChange(isTrustless ? 'lightwalletd' : 'zidecar')}
        className='mt-2 text-[10px] text-fg-muted hover:text-fg-high underline-offset-2 hover:underline'
      >
        switch to {isTrustless ? 'lightwalletd' : 'zidecar'} (advanced)
      </button>
    </div>
  );
};

/**
 * Compact preset dropdown for the settings endpoint screen. Mirrors the
 * onboarding picker so users don't have to remember a known-good URL
 * when their default goes down — pick a fallback, hit save, done.
 *
 * Custom endpoint string stays the source of truth on the
 * `networkState.endpoint` field; the picker just sets it. If the
 * user's current endpoint matches a preset, the picker pre-selects it.
 */
interface ZcashEndpointPickerProps {
  readonly currentUrl: string;
  readonly onPick: (url: string) => void;
}

const regionLabel = (region: RpcEndpointRegion): string => {
  switch (region) {
    case 'default': return 'recommended';
    case 'global': return 'global';
    case 'americas': return 'americas';
    case 'europe': return 'europe';
    case 'asia-pacific': return 'asia pacific';
    case 'community': return 'community';
  }
};

const ZcashEndpointPicker = ({ currentUrl, onPick }: ZcashEndpointPickerProps) => {
  const matched = findPresetByUrl(currentUrl);
  return (
    <div className='mb-3'>
      <div className='text-[10px] text-fg-muted mb-1'>preset</div>
      <select
        value={matched?.id ?? ''}
        onChange={e => {
          const preset = ZCASH_MAINNET_ENDPOINTS.find(p => p.id === e.target.value);
          if (preset) onPick(preset.url);
        }}
        className='w-full bg-input border border-border-soft px-2 py-1.5 text-xs focus:border-primary/50 focus:outline-none'
      >
        <option value='' disabled>{matched ? matched.label : 'custom — see below'}</option>
        {groupPresetsByRegion(ZCASH_MAINNET_ENDPOINTS).map(group => (
          <optgroup key={group.region} label={regionLabel(group.region)}>
            {group.presets.map(p => (
              <option key={p.id} value={p.id}>
                {p.label}{p.backend === 'zidecar' ? ' · trustless' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
};

export default SettingsNetworks;
