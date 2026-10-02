import { useEffect, useState } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../../../state';
import { privacySelector, type PrivacySettings } from '../../../state/privacy';
import { selectActiveNetwork } from '../../../state/keyring';
import { Section, SettingsScreen } from './settings-screen';
import { Row } from '@repo/ui/components/ui/row';
import { selectConnectedSiteCount } from './settings-status';
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
import { useExplain } from './settings-explain';
import { ZCASH_BACKENDS } from '../../../state/keyring/zcash-backend';
import { readEgressView } from '../../../net/egress-opt-in';
import { refreshEgress } from '../../../net/egress';
import { setDestinationOptIn } from '../../../net/ledger';
import { THORNAME_EGRESS } from '../../../services/thorname';

const ZCASHME_MODE_LABEL: Record<ZcashMeMode, string> = {
  off: 'off',
  directory: 'directory',
  live: 'live',
};

/** zcash.me - a Row(value) reading the persisted mode (an external system,
 *  so this is a plain effect, not derived state); the detail screen owns
 *  the mode picker itself (settings-zcashme.tsx). */
export function ZcashMeRow({ onExplain }: { onExplain?: () => void }) {
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
      onExplain={onExplain}
    />
  );
}

/** thorchain name lookups: the egress opt-in itself, so the backup carries it; off means ask first */
function ThorNameRow({ onExplain }: { onExplain?: () => void }) {
  const [on, setOn] = useState<boolean>();
  useEffect(() => {
    const load = () =>
      void readEgressView().then(v => setOn(!!v.find(d => d.id === THORNAME_EGRESS)?.on));
    const changed = (c: Record<string, unknown>, area: string) =>
      area === 'local' && 'netEgress' in c && load();
    load();
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  if (on === undefined) {
    return null;
  }
  return (
    <Row
      type='toggle'
      label='names'
      checked={on}
      onChange={next =>
        void setDestinationOptIn(THORNAME_EGRESS, next ? 'allowed' : undefined).then(refreshEgress)
      }
      onExplain={onExplain}
    />
  );
}

/** what the zcash node learns: memo decoys and the mempool watch, both zidecar's own (a lightwalletd has neither) */
function ZcashWireRows() {
  const memo = useStore(s => s.networks.networks.zcash.memoSyncStrategy ?? 'private');
  const mempool = useStore(s => s.networks.networks.zcash.mempoolWatch ?? 'off');
  const zidecar = useStore(
    s => !!ZCASH_BACKENDS[s.networks.networks.zcash.backend ?? 'zidecar'].extras,
  );
  const setMemo = useStore(s => s.networks.setMemoSyncStrategy);
  const setMempool = useStore(s => s.networks.setMempoolWatch);
  if (!zidecar) {
    return null;
  }
  return (
    <>
      <Row
        type='toggle'
        label='zcash: memo decoys'
        checked={memo === 'private'}
        onChange={v => void setMemo('zcash', v ? 'private' : 'fast')}
      />
      <Row
        type='toggle'
        label='zcash: instant pending'
        checked={mempool === 'on'}
        onChange={v => void setMempool('zcash', v ? 'on' : 'off')}
      />
    </>
  );
}

type Group = 'on screen' | 'network' | 'people';

/** the boolean privacy settings, in board order. `visible` hides a row the active network has no use for. */
const PRIVACY_ROWS: readonly {
  key: keyof PrivacySettings;
  label: string;
  group: Group;
  visible?: (network: NetworkType) => boolean;
}[] = [
  { key: 'hideBalances', label: 'hide balances', group: 'on screen' },
  { key: 'enableTransactionHistory', label: 'transaction history', group: 'on screen' },
  {
    key: 'enablePriceFetching',
    label: 'price display',
    group: 'on screen',
    visible: n => hasFeature(n, 'cosmos'),
  },
  {
    key: 'enableBackgroundSync',
    label: 'background sync',
    group: 'network',
    visible: n => hasFeature(n, 'cosmos'),
  },
  {
    key: 'enableTransparentBalances',
    label: 'cosmos balances',
    group: 'network',
    visible: n => hasFeature(n, 'cosmos'),
  },
  {
    key: 'enableExplorerLinks',
    label: 'explorer links',
    group: 'network',
    visible: n => hasFeature(n, 'zcash'),
  },
  {
    key: 'openZcashLinks',
    label: 'zcash: links',
    group: 'people',
    visible: n => hasFeature(n, 'zcash'),
  },
  { key: 'openZafuLinks', label: 'zafu: links', group: 'people' },
  { key: 'enableIdentity', label: 'zid identity', group: 'people' },
];

/**
 * Private contact discovery is opt-in and stores a relay endpoint the service
 * worker reads directly (plaintext, no secrets), so - like the Keplr toggle - it
 * is a standalone section rather than a boolean privacy-slice row. Default OFF:
 * absent/false means `zafu_discover_contacts` refuses with `not_available`.
 */
export function ContactDiscoverySection({ onExplain }: { onExplain?: () => void }) {
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
    <>
      <Row
        type='toggle'
        label='private contact discovery'
        checked={saved.enabled}
        onChange={next => (next ? save(true, endpoint, token) : save(false, endpoint, token))}
        onExplain={onExplain}
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
              className='border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono'
            />
            <input
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder='token (only if the relay asks for one)'
              className='border border-border-soft bg-transparent px-2 py-1.5 text-xs font-mono'
            />
          </div>
          <button
            onClick={() => {
              save(saved.enabled, endpoint, token);
              setOpen(false);
            }}
            disabled={!endpointValid}
            className='border border-zigner-gold bg-zigner-gold/10 py-2 text-xs text-zigner-gold disabled:opacity-30'
          >
            save
          </button>
        </div>
      </Sheet>
    </>
  );
}

/** privacy: one screen, no nested "all controls" (SetPrivacy.dc.html). proxy is shelved, so it has no row. */
export function SettingsPrivacy() {
  const { settings, setSetting } = useStore(privacySelector);
  const activeNetwork = useStore(selectActiveNetwork);
  const sites = useStore(selectConnectedSiteCount);
  const navigate = usePopupNav();
  const { explainProps, sheet } = useExplain();

  const rows = (group: Group) =>
    PRIVACY_ROWS.filter(r => r.group === group && (!r.visible || r.visible(activeNetwork))).map(
      r => (
        <Row
          key={r.key}
          type='toggle'
          label={r.label}
          checked={settings[r.key] as boolean}
          onChange={v => setSetting(r.key, v as never)}
          {...explainProps(r.label)}
        />
      ),
    );

  return (
    <SettingsScreen title='privacy' category='privacy' backPath={PopupPath.SETTINGS}>
      <div className='flex flex-col gap-4'>
        <Section title='on screen'>{rows('on screen')}</Section>
        <Section title='network'>
          {rows('network')}
          {hasFeature(activeNetwork, 'zcash') && <ZcashWireRows />}
          <Row
            type='screen'
            label='everything zafu talks to'
            onPress={() => navigate(PopupPath.SETTINGS_CONNECTIONS)}
          />
        </Section>
        <Section title='people'>
          {/* discovery derives from the zid contact layer; hide it when zid is off */}
          {settings.enableIdentity && (
            <ContactDiscoverySection {...explainProps('private contact discovery')} />
          )}
          {hasFeature(activeNetwork, 'zcash') && <ZcashMeRow {...explainProps('zcash.me')} />}
          <ThorNameRow {...explainProps('names')} />
          {rows('people')}
        </Section>
        <Section title='sites'>
          <Row
            type='value'
            label='connected sites'
            value={String(sites)}
            onPress={() => navigate(PopupPath.SETTINGS_CONNECTED_SITES)}
          />
        </Section>
      </div>
      {sheet}
    </SettingsScreen>
  );
}
