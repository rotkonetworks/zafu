import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { isPro } from '../../../state/license';
import { SettingsScreen } from './settings-screen';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { PopupPath } from '../paths';
import type { NetworkType } from '../../../state/keyring/network-types';
import { hasFeature } from '../../../config/networks';
import {
  DEFAULT_CONTACT_DISCOVERY_RELAY,
  relayEndpointForStorage,
} from '../../../config/contact-discovery-relay';
import { usePopupNav } from '../../../utils/navigate';
import { readZcashMeConfig, type ZcashMeMode } from '../../../services/zcashme/config';

const ZCASHME_MODE_LABEL: Record<ZcashMeMode, string> = {
  off: 'off',
  directory: 'directory',
  live: 'live',
};

/** zcash.me - a Row(value) reading the persisted mode (an external system,
 *  so this is a plain effect, not derived state); the detail screen owns
 *  the mode picker itself (settings-zcashme.tsx). */
function ZcashMeRow() {
  const navigate = usePopupNav();
  const [mode, setMode] = useState<ZcashMeMode>('off');
  useEffect(() => {
    void readZcashMeConfig().then(c => setMode(c.mode));
  }, []);
  return (
    <Row
      type='value'
      label='zcash.me'
      value={ZCASHME_MODE_LABEL[mode]}
      onPress={() => navigate(PopupPath.SETTINGS_ZCASHME)}
    />
  );
}

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

/** proxy - a Row(value) opening a Sheet to edit the socks5 host/port, rather
 *  than expanding inline (nothing expands in place). */
function ProxySection() {
  const { settings, setProxy } = useStore(privacySelector);
  const pro = useStore(isPro);
  // Defensive: settings persisted before the proxy field existed have no
  // proxy key. persist.ts now merges defaults on hydration, but guard here too.
  const proxy = settings.proxy ?? { enabled: false, host: '', port: 1080 };
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(proxy.host);
  const [port, setPort] = useState(String(proxy.port));

  const apply = () => {
    const p = parseInt(port, 10) || 1080;
    void setProxy({ enabled: true, host: host.trim(), port: p });
    setOpen(false);
  };

  const disable = () => {
    void setProxy({ enabled: false, host: host.trim(), port: parseInt(port, 10) || 1080 });
  };

  return (
    <RowGroup>
      <Row
        type='value'
        label='proxy'
        value={proxy.enabled ? `socks5://${proxy.host}:${proxy.port}` : 'off'}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title='proxy'>
        <div className='flex flex-col gap-3'>
          <p className='text-xs text-fg-muted'>
            {proxy.enabled
              ? `direct connections go through ${proxy.host}:${proxy.port}`
              : 'off - your ip is visible to servers you connect to'}
          </p>
          <div className='flex gap-2'>
            <input
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder='host'
              className='flex-1 rounded border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono'
            />
            <input
              value={port}
              onChange={e => setPort(e.target.value)}
              placeholder='port'
              className='w-16 rounded border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono'
            />
          </div>
          <div className='flex gap-2'>
            <button
              onClick={apply}
              disabled={!host.trim()}
              className='flex-1 rounded border border-zigner-gold bg-zigner-gold/10 py-2 text-xs text-zigner-gold disabled:opacity-30'
            >
              connect
            </button>
            {proxy.enabled && (
              <button
                onClick={disable}
                className='rounded border border-border-soft px-3 py-2 text-xs text-fg-muted'
              >
                turn off
              </button>
            )}
          </div>
          <p className='text-label text-fg-muted/60'>
            {pro
              ? 'routes all traffic - pro includes rotko proxy access'
              : 'routes all traffic through your socks5 - pro includes proxy access'}
          </p>
        </div>
      </Sheet>
    </RowGroup>
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
  const [open, setOpen] = useState(false);
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
    <RowGroup>
      <Row
        type='toggle'
        label='private contact discovery'
        description={
          saved.enabled
            ? `beaconing presence via ${saved.relayEndpoint || DEFAULT_CONTACT_DISCOVERY_RELAY}`
            : 'off - apps cannot learn which of your contacts are online'
        }
        checked={saved.enabled}
        onChange={next => (next ? save(true, endpoint, token) : save(false, endpoint, token))}
      />
      <Row
        type='value'
        label='relay'
        value={saved.relayEndpoint || DEFAULT_CONTACT_DISCOVERY_RELAY}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title='contact-discovery relay'>
        <div className='flex flex-col gap-3'>
          <div className='flex flex-col gap-2'>
            <input
              value={endpoint}
              onChange={e => setEndpoint(e.target.value)}
              placeholder={DEFAULT_CONTACT_DISCOVERY_RELAY}
              className='rounded border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono'
            />
            <input
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder='token (only if the relay asks for one)'
              className='rounded border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono'
            />
          </div>
          <button
            onClick={() => {
              save(saved.enabled, endpoint, token);
              setOpen(false);
            }}
            disabled={!endpointValid}
            className='rounded border border-zigner-gold bg-zigner-gold/10 py-2 text-xs text-zigner-gold disabled:opacity-30'
          >
            save
          </button>
          <p className='text-label text-fg-muted/60'>
            an app learns only which contacts are present in that app, under app-scoped handles -
            never your contact list, and unlinkable across apps.
          </p>
        </div>
      </Sheet>
    </RowGroup>
  );
}

export function SettingsPrivacy() {
  const { settings, setSetting } = useStore(privacySelector);
  const activeNetwork = useStore(selectActiveNetwork);

  const visibleRows = PRIVACY_ROWS.filter(row => !row.visible || row.visible(activeNetwork));

  return (
    <SettingsScreen title='all privacy controls' backPath={PopupPath.SETTINGS_PRIVACY_HOME}>
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
        {hasFeature(activeNetwork, 'zcash') && (
          <RowGroup>
            <ZcashMeRow />
          </RowGroup>
        )}
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
