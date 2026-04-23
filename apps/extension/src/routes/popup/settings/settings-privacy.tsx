import { useState } from 'react';
import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { isPro } from '../../../state/license';
import { SettingsScreen } from './settings-screen';
import { isIbcNetwork, type NetworkType } from '../../../state/keyring/network-types';

interface PrivacyRow {
  key: keyof PrivacySettings;
  label: string;
  onLabel: string;
  offLabel: string;
  /** filter function — return true if this row is visible for the given network */
  visible?: (network: NetworkType) => boolean;
}

const PRIVACY_ROWS: readonly PrivacyRow[] = [
  {
    key: 'enableTransparentBalances',
    label: 'cosmos balances',
    onLabel: 'querying rpc nodes for balances',
    offLabel: 'balances hidden — no rpc queries',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enableTransactionHistory',
    label: 'transaction history',
    onLabel: 'saving history locally',
    offLabel: 'history disabled',
  },
  {
    key: 'enableBackgroundSync',
    label: 'background sync',
    onLabel: 'syncing periodically in background',
    offLabel: 'sync only when extension is open',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enablePriceFetching',
    label: 'price display',
    onLabel: 'fetching prices — apis cannot see your addresses',
    offLabel: 'prices hidden',
    visible: n => n === 'penumbra' || isIbcNetwork(n),
  },
];

function Row({
  label,
  stateLabel,
  checked,
  onChange,
}: {
  label: string;
  stateLabel: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className='flex items-start justify-between gap-4 py-3'>
      <div className='flex-1'>
        <p className='text-sm font-medium'>{label}</p>
        <p className={`text-xs mt-0.5 ${checked ? 'text-green-500' : 'text-fg-muted'}`}>
          {stateLabel}
        </p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className='shrink-0 transition-colors'
      >
        {checked
          ? <span className='i-lucide-toggle-right size-7 text-green-400' />
          : <span className='i-lucide-toggle-left size-7 text-fg-muted/40' />
        }
      </button>
    </div>
  );
}

function ProxySection() {
  const { settings, setProxy } = useStore(privacySelector);
  const pro = useStore(isPro);
  const proxy = settings.proxy;
  const [host, setHost] = useState(proxy.host);
  const [port, setPort] = useState(String(proxy.port));

  const apply = () => {
    const p = parseInt(port, 10) || 1080;
    void setProxy({ enabled: true, host: host.trim(), port: p });
  };

  const disable = () => {
    void setProxy({ enabled: false, host: host.trim(), port: parseInt(port, 10) || 1080 });
  };

  return (
    <div className='py-3'>
      <div className='flex items-center justify-between'>
        <div>
          <p className='text-sm font-medium'>proxy</p>
          <p className={`text-xs mt-0.5 ${proxy.enabled ? 'text-green-500' : 'text-fg-muted'}`}>
            {proxy.enabled ? `socks5://${proxy.host}:${proxy.port}` : 'direct connection - ip visible to servers'}
          </p>
        </div>
        <button onClick={() => proxy.enabled ? disable() : (host ? apply() : undefined)} className='shrink-0'>
          {proxy.enabled
            ? <span className='i-lucide-toggle-right size-7 text-green-400' />
            : <span className='i-lucide-toggle-left size-7 text-fg-muted/40' />
          }
        </button>
      </div>
      {!proxy.enabled && (
        <div className='mt-2 flex gap-2'>
          <input
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder='host'
            className='flex-1 rounded border border-border-hard-soft bg-transparent px-2 py-1 text-xs font-mono'
          />
          <input
            value={port}
            onChange={e => setPort(e.target.value)}
            placeholder='port'
            className='w-16 rounded border border-border-hard-soft bg-transparent px-2 py-1 text-xs font-mono'
          />
          <button
            onClick={apply}
            disabled={!host.trim()}
            className='rounded border border-border-hard-soft px-2 py-1 text-xs disabled:opacity-30'
          >
            connect
          </button>
        </div>
      )}
      <p className='text-[9px] text-fg-muted/40 mt-1'>
        {pro
          ? 'routes all traffic through proxy - pro includes rotko proxy access'
          : 'routes all traffic through your socks5 proxy - pro includes proxy access'}
      </p>
    </div>
  );
}

export function SettingsPrivacy() {
  const { settings, setSetting } = useStore(privacySelector);
  const activeNetwork = useStore(selectActiveNetwork);

  const visibleRows = PRIVACY_ROWS.filter(
    row => !row.visible || row.visible(activeNetwork),
  );

  return (
    <SettingsScreen title='privacy'>
      <div className='flex flex-col divide-y divide-border/40'>
        {visibleRows.map(row => (
          <Row
            key={row.key}
            label={row.label}
            stateLabel={settings[row.key] ? row.onLabel : row.offLabel}
            checked={settings[row.key] as boolean}
            onChange={v => setSetting(row.key, v as never)}
          />
        ))}
        <ProxySection />
        {visibleRows.length === 0 && (
          <p className='py-8 text-center text-sm text-fg-muted'>
            no privacy settings for this network
          </p>
        )}
      </div>
    </SettingsScreen>
  );
}
