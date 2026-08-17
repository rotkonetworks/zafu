import { useState } from 'react';
import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { isPro } from '../../../state/license';
import { SettingsScreen } from './settings-screen';
import { ToggleSwitch } from '../../../components/toggle-switch';
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
    key: 'hideBalances',
    label: 'hide balances',
    onLabel: 'amounts blurred across every screen',
    offLabel: 'amounts visible',
  },
  {
    key: 'enableIdentity',
    label: 'zid identity',
    onLabel: 'sites can derive per-site identities',
    offLabel: 'off - menu, sign approvals, e2ee disabled',
  },
  {
    key: 'enableTransparentBalances',
    label: 'cosmos balances',
    onLabel: 'querying rpc for balances',
    offLabel: 'hidden - no rpc queries',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enableTransactionHistory',
    label: 'transaction history',
    onLabel: 'saved locally',
    offLabel: 'disabled',
  },
  {
    key: 'enableBackgroundSync',
    label: 'background sync',
    onLabel: 'syncing in background',
    offLabel: 'only when extension is open',
    visible: n => isIbcNetwork(n) || n === 'penumbra',
  },
  {
    key: 'enablePriceFetching',
    label: 'price display',
    onLabel: 'fetching prices - apis cannot see your addresses, but do see your ip',
    offLabel: 'hidden',
    visible: n => n === 'penumbra' || isIbcNetwork(n),
  },
  {
    key: 'enableExplorerLinks',
    label: 'explorer links',
    onLabel: 'tx rows link to a block explorer - it sees your ip and which tx you open',
    offLabel: 'copy-only - nothing leaves the wallet',
    visible: n => n === 'zcash',
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
        <p className={`text-xs mt-0.5 ${checked ? 'text-fg-high' : 'text-fg-muted'}`}>
          {stateLabel}
        </p>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} label={label} className='mt-0.5' />
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
          <p className={`text-xs mt-0.5 ${proxy.enabled ? 'text-fg-high' : 'text-fg-muted'}`}>
            {proxy.enabled
              ? `socks5://${proxy.host}:${proxy.port}`
              : 'direct - ip visible to servers'}
          </p>
        </div>
        <ToggleSwitch
          checked={proxy.enabled}
          onChange={next => (next ? (host.trim() ? apply() : undefined) : disable())}
          label='proxy'
        />
      </div>
      {!proxy.enabled && (
        <div className='mt-2 flex gap-2'>
          <input
            value={host}
            onChange={e => setHost(e.target.value)}
            placeholder='host'
            className='flex-1 rounded border border-border-soft bg-transparent px-2 py-1 text-xs font-mono'
          />
          <input
            value={port}
            onChange={e => setPort(e.target.value)}
            placeholder='port'
            className='w-16 rounded border border-border-soft bg-transparent px-2 py-1 text-xs font-mono'
          />
          <button
            onClick={apply}
            disabled={!host.trim()}
            className='rounded border border-border-soft px-2 py-1 text-xs disabled:opacity-30'
          >
            connect
          </button>
        </div>
      )}
      <p className='text-label text-fg-muted/40 mt-1'>
        {pro
          ? 'routes all traffic - pro includes rotko proxy access'
          : 'routes all traffic through your socks5 - pro includes proxy access'}
      </p>
    </div>
  );
}

export function SettingsPrivacy() {
  const { settings, setSetting } = useStore(privacySelector);
  const activeNetwork = useStore(selectActiveNetwork);

  const visibleRows = PRIVACY_ROWS.filter(row => !row.visible || row.visible(activeNetwork));

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
