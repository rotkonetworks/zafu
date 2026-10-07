import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { useDisableNetwork, useEnableNetwork } from '../../../hooks/enable-network';
import { NETWORK_BLURB } from '../../../components/network-sheet';
import { getNetwork, getTopLevelNetworks } from '../../../config/networks';
import { DEFAULT_RELAY_URL } from '../../../config/multisig-relay';
import { relayHost } from '../../../config/people-relay';
import { HARDWARE_WALLET_ENABLED, LEDGER_TRANSPARENT_ENABLED } from '../../../config/feature-flags';
import { openPageInTab } from '../../../utils/popup-detection';
import { PagePath } from '../../page/paths';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { Section, SettingsScreen } from './settings-screen';
import { isZigner, networkNames } from './settings-status';
import { useExplain, type ExplainId } from './settings-explain';

/** the one place a network turns on or off; its node and chains live on its own screen */
const NetworksRow = () => {
  const enabled = useStore(useShallow(selectEnabledNetworks));
  const disable = useDisableNetwork();
  const enable = useEnableNetwork();
  const [open, setOpen] = useState(false);
  const { explainProps, sheet } = useExplain();
  return (
    <>
      {/* no-explain: opens the switches, and each of them explains itself */}
      <Row
        type='value'
        label='networks'
        description='a network that is off is never contacted'
        value={networkNames(enabled).join(' · ') || 'none on'}
        onPress={() => setOpen(true)}
      />
      <Sheet open={open} onOpenChange={setOpen} title='networks'>
        <RowGroup>
          {getTopLevelNetworks().map(n => (
            <Row
              key={n}
              type='toggle'
              label={getNetwork(n).name}
              description={NETWORK_BLURB[n]}
              checked={enabled.includes(n)}
              onChange={on => void (on ? enable(n) : disable(n))}
              {...explainProps(`network.${n}Enable` as ExplainId)}
            />
          ))}
        </RowGroup>
      </Sheet>
      {sheet}
    </>
  );
};

/** the relays this computer's multisig wallets meet on */
const selectMultisigRelays = (s: Parameters<typeof selectEnabledNetworks>[0]) =>
  [
    ...new Set(
      (Array.isArray(s.wallets.zcashWallets) ? s.wallets.zcashWallets : [])
        .filter(w => w.multisig && !w.multisig.hidden)
        .map(w => relayHost(w.multisig?.relayUrl || DEFAULT_RELAY_URL)),
    ),
  ].join(', ');

/** wallets and devices (SetDevices.dc.html) */
export const SettingsDevicesHome = () => {
  const navigate = usePopupNav();
  const keyInfos = useStore(s => s.keyRing.keyInfos);
  const enabled = useStore(useShallow(selectEnabledNetworks));
  const relays = useStore(selectMultisigRelays);
  const zcashOn = enabled.includes('zcash');
  const zigner = keyInfos.some(isZigner);
  const keystone = keyInfos.some(
    k => k.type === 'zigner-zafu' && k.insensitive['coldSignerType'] === 'keystone',
  );

  return (
    <SettingsScreen
      title='wallets and devices'
      category='devices'
      home
      backPath={PopupPath.SETTINGS}
    >
      <div className='flex flex-col gap-4'>
        <Section title='wallets'>
          <Row
            type='value'
            label='wallets'
            description='names and labels stay on this computer'
            value={String(keyInfos.length)}
            preload={PopupPath.SETTINGS_WALLETS}
            onPress={() => navigate(PopupPath.SETTINGS_WALLETS)}
          />
          <NetworksRow />
          {enabled.includes('penumbra') && (
            <Row
              type='screen'
              label='penumbra'
              description='node, ibc chains, sync while closed'
              preload={PopupPath.SETTINGS_PENUMBRA_NETWORK}
              onPress={() => navigate(PopupPath.SETTINGS_PENUMBRA_NETWORK)}
            />
          )}
        </Section>
        <Section title='signers'>
          <Row
            type='value'
            label='zigner'
            description='air-gapped · signs by qr, never online'
            value={zigner ? 'paired' : 'not paired'}
            preload={PopupPath.SETTINGS_ZIGNER}
            onPress={() => navigate(PopupPath.SETTINGS_ZIGNER)}
          />
          <Row
            type='value'
            label='keystone'
            description='air-gapped · signs by qr'
            value={keystone ? 'paired' : 'not paired'}
            preload={PopupPath.SETTINGS_CONNECT_DEVICE}
            onPress={() => navigate(PopupPath.SETTINGS_CONNECT_DEVICE)}
          />
          {zcashOn && (HARDWARE_WALLET_ENABLED || LEDGER_TRANSPARENT_ENABLED) && (
            <Row
              type='screen'
              label='ledger'
              description='beta · by usb, on this computer only'
              // webhid dies with the popup, so the ledger flow runs in a tab
              onPress={() => void openPageInTab(PagePath.CONNECT_LEDGER, true)}
            />
          )}
          {zcashOn && (
            <Row
              type='value'
              label='multisig'
              description='its relay sees sealed rounds and your ip'
              value={relays || 'none yet'}
              preload={PopupPath.MULTISIG}
              onPress={() => navigate(PopupPath.MULTISIG)}
            />
          )}
        </Section>
        <Section title='zafu'>
          <Row
            type='value'
            label='about'
            description='version and source'
            value={chrome.runtime.getManifest().version}
            preload={PopupPath.SETTINGS_ABOUT}
            onPress={() => navigate(PopupPath.SETTINGS_ABOUT)}
          />
        </Section>
      </div>
    </SettingsScreen>
  );
};
