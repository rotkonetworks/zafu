import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { isPro } from '../../../state/license';
import { SettingsScreen } from './settings-screen';
import { Toggle } from '@repo/ui/components/ui/toggle';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import type { NetworkType } from '../../../state/keyring/network-types';
import { hasFeature } from '../../../config/networks';
import {
  DEFAULT_CONTACT_DISCOVERY_RELAY,
  relayEndpointForStorage,
} from '../../../config/contact-discovery-relay';

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
    visible: n => hasFeature(n, 'cosmos'),
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
    visible: n => hasFeature(n, 'cosmos'),
  },
  {
    key: 'enablePriceFetching',
    label: 'price display',
    onLabel: 'fetching prices - apis cannot see your addresses, but do see your ip',
    offLabel: 'hidden',
    visible: n => hasFeature(n, 'cosmos'),
  },
  {
    key: 'enableExplorerLinks',
    label: 'explorer links',
    onLabel: 'tx rows link to a block explorer - it sees your ip and which tx you open',
    offLabel: 'copy-only - nothing leaves the wallet',
    visible: n => hasFeature(n, 'zcash'),
  },
  {
    key: 'openZcashLinks',
    label: 'zcash: links',
    onLabel: 'links on websites open in zafu',
    offLabel: 'links open in your default zcash app',
    visible: n => hasFeature(n, 'zcash'),
  },
];

function ProxySection() {
  const { settings, setProxy } = useStore(privacySelector);
  const pro = useStore(isPro);
  // Defensive: settings persisted before the proxy field existed have no
  // proxy key. persist.ts now merges defaults on hydration, but guard here too.
  const proxy = settings.proxy ?? { enabled: false, host: '', port: 1080 };
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
        <Toggle
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

/**
 * Private contact discovery is opt-in and stores a relay endpoint the service
 * worker reads directly (plaintext, no secrets), so - like the Keplr toggle - it
 * is a standalone section rather than a boolean privacy-slice row. Default OFF:
 * absent/false means `zafu_discover_contacts` refuses with `not_available`.
 */
export function ContactDiscoverySection() {
  const [saved, setSaved] = useState<{
    enabled: boolean;
    relayEndpoint: string;
    relayToken: string;
  } | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    void localExtStorage.get('zidDiscovery').then(v => {
      const next = {
        enabled: v?.enabled === true,
        relayEndpoint: v?.relayEndpoint ?? '',
        relayToken: v?.relayToken ?? '',
      };
      setSaved(next);
      // show what the wallet will actually use, so "enable" is one click even
      // for a user who never heard of a relay
      setEndpoint(next.relayEndpoint || DEFAULT_CONTACT_DISCOVERY_RELAY);
      setToken(next.relayToken);
    });
  }, []);

  if (saved === null) {
    return null;
  }

  const save = (enabled: boolean, relayEndpoint: string, relayToken: string): void => {
    // blank means "the built-in default" (see relayEndpointForStorage)
    const stored = relayEndpointForStorage(relayEndpoint);
    const next = { enabled, relayEndpoint: stored, relayToken: relayToken.trim() };
    setSaved(next);
    setEndpoint(stored || DEFAULT_CONTACT_DISCOVERY_RELAY);
    setToken(next.relayToken);
    void localExtStorage.set('zidDiscovery', next);
  };

  const endpointValid = /^https?:\/\//.test(endpoint.trim());

  return (
    <div className='py-3'>
      <div className='flex items-start justify-between gap-4'>
        <div className='flex-1'>
          <p className='text-sm font-medium'>private contact discovery</p>
          <p className={`text-xs mt-0.5 ${saved.enabled ? 'text-fg-high' : 'text-fg-muted'}`}>
            {saved.enabled
              ? `beaconing presence via ${saved.relayEndpoint || DEFAULT_CONTACT_DISCOVERY_RELAY}${saved.relayToken ? ' (with a token)' : ''}`
              : 'off - apps cannot learn which of your contacts are online'}
          </p>
        </div>
        <Toggle
          checked={saved.enabled}
          onChange={next =>
            next
              ? endpointValid
                ? save(true, endpoint, token)
                : undefined
              : save(false, endpoint, token)
          }
          label='private contact discovery'
          className='mt-0.5'
        />
      </div>
      {!saved.enabled && (
        <div className='mt-2 flex gap-2'>
          <input
            value={endpoint}
            onChange={e => setEndpoint(e.target.value)}
            placeholder={DEFAULT_CONTACT_DISCOVERY_RELAY}
            className='flex-1 rounded border border-border-soft bg-transparent px-2 py-1 text-xs font-mono'
          />
          <input
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder='token (only if the relay asks for one)'
            className='w-48 rounded border border-border-soft bg-transparent px-2 py-1 text-xs font-mono'
          />
          <button
            onClick={() => save(true, endpoint, token)}
            disabled={!endpointValid}
            className='rounded border border-border-soft px-2 py-1 text-xs disabled:opacity-30'
          >
            enable
          </button>
        </div>
      )}
      <p className='text-label text-fg-muted/40 mt-1'>
        an app learns only which contacts are present in that app, under app-scoped handles - never
        your contact list, and unlinkable across apps.
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
      <div className='flex flex-col gap-4'>
        {visibleRows.length > 0 && (
          <RowGroup>
            {visibleRows.map(row => (
              <Row
                key={row.key}
                type='toggle'
                label={row.label}
                description={settings[row.key] ? row.onLabel : row.offLabel}
                checked={settings[row.key] as boolean}
                onChange={v => setSetting(row.key, v as never)}
              />
            ))}
          </RowGroup>
        )}
        <ProxySection />
        {/* discovery derives from the zid contact layer; hide it when zid is off */}
        {(settings.enableIdentity ?? true) && <ContactDiscoverySection />}
        {/* Keplr "act as" toggle moved to Networks → Penumbra section
            since it only affects the Penumbra/IBC scope. */}
        {visibleRows.length === 0 && (
          <p className='py-8 text-center text-sm text-fg-muted'>
            no privacy settings for this network
          </p>
        )}
      </div>
    </SettingsScreen>
  );
}
