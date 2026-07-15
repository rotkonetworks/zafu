/**
 * settings page for managing enabled networks + per-network endpoints
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectSetActiveNetwork,
  type NetworkType,
} from '../../../state/keyring';
import { isIbcNetwork } from '../../../state/keyring/network-types';
import {
  networksSelector,
  type NetworkId,
  type MemoSyncStrategy,
  type MempoolWatchSetting,
} from '../../../state/networks';
import { backendTrustDescription, type ZcashBackend } from '../../../state/keyring/zcash-backend';
import { isMempoolWatchEnabled } from '../../../services/mempool-watch/strategy';
import {
  ZCASH_MAINNET_ENDPOINTS,
  findPresetByUrl,
  groupPresetsByRegion,
  type RpcEndpointRegion,
} from '../../../config/zcash-endpoints';
import {
  measurePresetLatencies,
  type EndpointLatency,
} from '../../../state/keyring/endpoint-latency';
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

const getColorHex = (color: string): string => NETWORK_COLORS[color] ?? '#6B7280';

export const SettingsNetworks = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const toggleNetwork = useStore(state => state.keyRing.toggleNetwork);
  const privacySetSetting = useStore(state => state.privacy.setSetting);
  const transparentEnabled = useStore(state => state.privacy.settings.enableTransparentBalances);
  const {
    networks: networkState,
    setNetworkEndpoint,
    setMemoSyncStrategy,
    setMempoolWatch,
    setZcashBackend,
  } = useStore(networksSelector);

  // Deep-link: `?network=zcash` auto-expands that card. Used by the home
  // sync-bar "switch node" action so the user lands on the node picker,
  // not a generic list.
  const [searchParams] = useSearchParams();
  const initialExpand = (() => {
    const n = searchParams.get('network');
    return n && (LAUNCHED_NETWORKS as readonly string[]).includes(n) ? (n as NetworkType) : null;
  })();
  const [expandedNetwork, setExpandedNetwork] = useState<NetworkType | null>(initialExpand);
  const [editingEndpoint, setEditingEndpoint] = useState(
    initialExpand ? (networkState[initialExpand as NetworkId]?.endpoint ?? '') : '',
  );
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
            <div
              key={networkId}
              className={cn(
                'rounded-lg border overflow-hidden transition-colors',
                isActive ? 'border-primary/60' : 'border-border-soft',
              )}
            >
              {/* network row */}
              <div className='flex items-center p-3'>
                {/* name — click to set active (if enabled) */}
                <button
                  onClick={() => {
                    if (isEnabled) {
                      void setActiveNetwork(networkId);
                    } else {
                      void handleToggle(networkId);
                    }
                  }}
                  className='flex flex-1 items-center gap-3'
                >
                  <div
                    className={cn(
                      'h-3 w-3 rounded-full',
                      isActive && 'ring-2 ring-primary/40 ring-offset-1 ring-offset-background',
                    )}
                    style={{ backgroundColor: getColorHex(network.color) }}
                  />
                  <span className={cn('font-medium text-sm', !isEnabled && 'text-fg-muted')}>
                    {network.name}
                  </span>
                  {isActive && (
                    <span className='text-label px-1.5 py-0.5 rounded-md bg-primary/15 text-zigner-gold font-medium leading-none'>
                      active
                    </span>
                  )}
                  {network.transparent && (
                    <span className='text-label px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 font-medium leading-none'>
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
                        isExpanded ? 'text-fg' : 'text-fg-muted hover:text-fg-high',
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
                      isEnabled
                        ? 'border-zigner-gold bg-zigner-gold'
                        : 'border-muted-foreground/50',
                    )}
                  >
                    {isEnabled && <span className='i-lucide-check h-3 w-3 text-zigner-dark' />}
                  </button>
                </div>
              </div>

              {/* endpoint config — expanded. One job up front: pick a
                  working node. Trust status is a single quiet line derived
                  from the backend; every tuning knob (custom url, backend
                  override, memo privacy, mempool watch) lives behind one
                  "advanced" disclosure so the common path stays calm. */}
              {isExpanded && isEnabled && (
                <div className='border-t border-border-soft p-3 bg-elev-2/10 flex flex-col gap-3'>
                  {networkId === 'zcash' ? (
                    <ZcashEndpointPanel
                      state={state as ZcashNetworkState | undefined}
                      editingEndpoint={editingEndpoint}
                      setEditingEndpoint={setEditingEndpoint}
                      saving={saving}
                      onPick={async url => {
                        // Persist via the store action; keep the panel open
                        // so the user can verify (or pick again) without
                        // re-expanding the card.
                        setSaving(true);
                        try {
                          await setNetworkEndpoint('zcash', url);
                          setEditingEndpoint(url);
                        } finally {
                          setSaving(false);
                        }
                      }}
                      onSaveCustom={() => void handleSaveEndpoint(networkId)}
                      onBackendChange={b => void setZcashBackend(b)}
                      onStrategyChange={st => void setMemoSyncStrategy('zcash', st)}
                      onMempoolChange={st => void setMempoolWatch('zcash', st)}
                    />
                  ) : (
                    <div>
                      <div className='text-label text-fg-muted mb-1'>endpoint</div>
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
                    </div>
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

interface ZcashNetworkState {
  endpoint?: string;
  memoSyncStrategy?: MemoSyncStrategy;
  mempoolWatch?: MempoolWatchSetting;
  backend?: ZcashBackend;
}

const regionLabel = (region: RpcEndpointRegion): string => {
  switch (region) {
    case 'default':
      return 'recommended';
    case 'global':
      return 'global';
    case 'americas':
      return 'americas';
    case 'europe':
      return 'europe';
    case 'asia-pacific':
      return 'asia pacific';
    case 'community':
      return 'community';
  }
};

/**
 * The zcash node panel, composed around the one thing users come for:
 * picking a working node.
 *
 *   1. node select — latencies measured automatically on mount, shown
 *      inline as `· 23ms`, dead nodes marked unreachable. No manual
 *      "test" button to discover.
 *   2. one quiet trust line — derived from the backend, a colored dot
 *      and six words instead of badge + paragraph.
 *   3. "advanced" disclosure — custom url, backend override, memo
 *      privacy, mempool watch. Closed by default; warnings appear as a
 *      single hint line on the selected option, not amber boxes.
 */
const ZcashEndpointPanel = ({
  state,
  editingEndpoint,
  setEditingEndpoint,
  saving,
  onPick,
  onSaveCustom,
  onBackendChange,
  onStrategyChange,
  onMempoolChange,
}: {
  readonly state: ZcashNetworkState | undefined;
  readonly editingEndpoint: string;
  readonly setEditingEndpoint: (v: string) => void;
  readonly saving: boolean;
  readonly onPick: (url: string) => void;
  readonly onSaveCustom: () => void;
  readonly onBackendChange: (b: ZcashBackend) => void;
  readonly onStrategyChange: (s: MemoSyncStrategy) => void;
  readonly onMempoolChange: (s: MempoolWatchSetting) => void;
}) => {
  const backend: ZcashBackend = state?.backend ?? 'zidecar';
  const strategy: MemoSyncStrategy = state?.memoSyncStrategy ?? 'private';
  const mempool: MempoolWatchSetting = state?.mempoolWatch ?? 'off';
  const matched = findPresetByUrl(editingEndpoint);
  const trust = backendTrustDescription(backend);
  const isTrustless = backend === 'zidecar';
  const mempoolAvailable = backend === 'zidecar';
  const mempoolOn = mempoolAvailable && isMempoolWatchEnabled(mempool, backend);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [latencies, setLatencies] = useState<Map<string, EndpointLatency> | null>(null);

  // Measure once per panel open — ~10 tiny requests; cheap enough that
  // a manual "test latencies" affordance was just an extra decision.
  useEffect(() => {
    let cancelled = false;
    void measurePresetLatencies().then(m => {
      if (!cancelled) {
        setLatencies(m);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rttSuffix = (url: string): string => {
    const lat = latencies?.get(url);
    if (!lat) {
      return '';
    }
    if (lat.rttMs === null) {
      return ' · unreachable';
    }
    return ` · ${lat.rttMs}ms`;
  };

  return (
    <>
      {/* 1 · node */}
      <div>
        <div className='text-label text-fg-muted mb-1'>node</div>
        <select
          value={matched?.id ?? ''}
          onChange={e => {
            const preset = ZCASH_MAINNET_ENDPOINTS.find(p => p.id === e.target.value);
            if (preset) {
              onPick(preset.url);
            }
          }}
          className='w-full bg-input border border-border-soft px-2 py-1.5 text-xs focus:border-primary/50 focus:outline-none'
        >
          <option value='' disabled>
            {matched ? matched.label : 'custom url'}
          </option>
          {groupPresetsByRegion(ZCASH_MAINNET_ENDPOINTS).map(group => (
            <optgroup key={group.region} label={regionLabel(group.region)}>
              {group.presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.backend === 'zidecar' ? ' · trustless' : ''}
                  {rttSuffix(p.url)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* 2 · trust line */}
      <div className='flex items-center gap-1.5 text-label lowercase'>
        <span
          className={cn('h-1.5 w-1.5 rounded-full', isTrustless ? 'bg-green-400' : 'bg-amber-400')}
        />
        <span className={isTrustless ? 'text-green-400' : 'text-amber-400'}>{trust.label}</span>
        <span className='text-fg-muted'>
          {isTrustless ? '· responses verified locally' : '· wallet trusts this server'}
        </span>
      </div>

      {/* 3 · advanced disclosure */}
      <div className='border-t border-border-soft pt-2'>
        <button
          type='button'
          onClick={() => setShowAdvanced(v => !v)}
          className='flex w-full items-center gap-1 text-label text-fg-muted lowercase transition-colors hover:text-fg-high'
        >
          <span
            className={cn(
              'i-lucide-chevron-right h-3.5 w-3.5 transition-transform',
              showAdvanced && 'rotate-90',
            )}
          />
          advanced
        </button>

        {showAdvanced && (
          <div className='mt-3 flex flex-col gap-4'>
            {/* custom url */}
            <div>
              <div className='text-label text-fg-muted mb-1'>custom url</div>
              <div className='flex gap-2'>
                <input
                  type='text'
                  value={editingEndpoint}
                  onChange={e => setEditingEndpoint(e.target.value)}
                  placeholder='https://...'
                  className='flex-1 bg-input border border-border-soft px-2 py-1.5 text-xs font-mono focus:border-primary/50 focus:outline-none'
                />
                <button
                  onClick={onSaveCustom}
                  disabled={saving}
                  className='px-3 py-1.5 text-xs bg-zigner-gold text-zigner-dark hover:bg-primary/90 transition-colors disabled:opacity-50'
                >
                  {saving ? '...' : 'save'}
                </button>
              </div>
            </div>

            {/* backend override */}
            <div>
              <div className='text-label text-fg-muted mb-1'>sync backend</div>
              <SegmentedPair
                value={backend}
                a={{ id: 'zidecar', label: 'zidecar' }}
                b={{ id: 'lightwalletd', label: 'lightwalletd' }}
                onChange={v => onBackendChange(v as ZcashBackend)}
              />
              <p className='mt-1 text-label text-fg-dim lowercase leading-snug'>{trust.summary}</p>
            </div>

            {/* memo privacy */}
            <div>
              <div className='text-label text-fg-muted mb-1'>memo sync privacy</div>
              <SegmentedPair
                value={strategy}
                a={{ id: 'private', label: 'private' }}
                b={{ id: 'fast', label: 'fast' }}
                onChange={v => onStrategyChange(v as MemoSyncStrategy)}
              />
              <p className='mt-1 text-label text-fg-dim lowercase leading-snug'>
                {strategy === 'private'
                  ? 'decoy requests hide which blocks your wallet cares about.'
                  : 'no decoys — the server learns which block ranges are yours. memos stay encrypted.'}
              </p>
            </div>

            {/* mempool watch */}
            <div>
              <button
                type='button'
                disabled={!mempoolAvailable}
                onClick={() => mempoolAvailable && onMempoolChange(mempoolOn ? 'off' : 'on')}
                className={cn(
                  'flex w-full items-center justify-between gap-2 text-left',
                  !mempoolAvailable && 'opacity-50 cursor-not-allowed',
                )}
              >
                <span className='text-label text-fg-muted'>instant pending (mempool watch)</span>
                <span
                  className={cn(
                    'relative h-4 w-7 shrink-0 rounded-full border-2 transition-colors',
                    mempoolOn
                      ? 'border-zigner-gold bg-zigner-gold/30'
                      : 'border-muted-foreground/50',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0 h-3 w-3 rounded-full bg-zigner-gold transition-all',
                      mempoolOn ? 'left-3' : 'left-0',
                    )}
                  />
                </span>
              </button>
              <p className='mt-1 text-label text-fg-dim lowercase leading-snug'>
                {!mempoolAvailable
                  ? 'needs a zidecar node.'
                  : mempoolOn
                    ? 'polling — the server sees a continuous "online" signal from your wallet.'
                    : 'shows incoming funds before they confirm. the server learns when you are online.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

/** Two-option segmented control — radio cards were heavy for binary picks. */
const SegmentedPair = ({
  value,
  a,
  b,
  onChange,
}: {
  readonly value: string;
  readonly a: { id: string; label: string };
  readonly b: { id: string; label: string };
  readonly onChange: (id: string) => void;
}) => (
  <div className='flex border border-border-soft'>
    {[a, b].map(opt => (
      <button
        key={opt.id}
        type='button'
        onClick={() => onChange(opt.id)}
        className={cn(
          'flex-1 px-2 py-1.5 text-xs lowercase transition-colors',
          value === opt.id
            ? 'bg-zigner-gold/15 text-zigner-gold'
            : 'text-fg-muted hover:text-fg-high',
        )}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

export default SettingsNetworks;
