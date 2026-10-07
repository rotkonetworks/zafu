import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { CATEGORY_MARKS, SettingsScreen, type SettingsCategory } from './settings-screen';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';
import { useZafuTheme } from './settings-appearance';
import { useDestinationsOn, useStored } from './use-stored';
import { useZcashMeMode, ZCASHME_MODE_LABEL } from '../../../services/zcashme/config';
import { discoveryOn } from '../../../config/contact-discovery-relay';
import {
  devicesStatus,
  displayStatus,
  networkNames,
  networkStatus,
  peopleStatus,
  securityStatus,
  selectConnectedSiteCount,
  selectUnbackedSeatCount,
  selectZcashNodeHost,
  selectZcashOpenings,
  selectZignerPaired,
  zcashStatus,
  type Status,
} from './settings-status';
import { Clipped } from '@repo/ui/components/ui/clipped';

const useSecurityStatus = () => {
  const unbacked = useStore(selectUnbackedSeatCount);
  const { minutes } = useAutoLock();
  return securityStatus(
    unbacked,
    AUTO_LOCK_OPTIONS.find(o => o.value === minutes)?.label ?? `${minutes} min`,
  );
};

const useNetworkStatus = () => {
  return networkStatus(useDestinationsOn(), useStore(selectConnectedSiteCount));
};

const useZcashStatus = () =>
  zcashStatus(
    useStore(s => selectEnabledNetworks(s).includes('zcash')),
    useStore(selectZcashNodeHost),
    useStore(selectZcashOpenings),
  );

const usePeopleStatus = () => {
  const zcashOn = useStore(s => selectEnabledNetworks(s).includes('zcash'));
  const mode = useZcashMeMode() ?? 'off';
  return peopleStatus(
    useStore(s => s.privacy.settings.enableIdentity),
    discoveryOn(useStored('zidDiscovery')?.v),
    zcashOn ? ZCASHME_MODE_LABEL[mode] : undefined,
  );
};

const useDisplayStatus = () =>
  displayStatus(
    useZafuTheme().theme,
    useStore(s => s.privacy.settings.hideBalances),
  );

const useDevicesStatus = () =>
  devicesStatus(
    useStore(s => s.keyRing.keyInfos.length),
    useStore(selectZignerPaired),
    networkNames(useStore(useShallow(selectEnabledNetworks))),
  );

const GROUPS: readonly {
  id: SettingsCategory;
  title: string;
  href: PopupPath;
  useStatus: () => Status;
}[] = [
  {
    id: 'security',
    title: 'security',
    href: PopupPath.SETTINGS_SECURITY,
    useStatus: useSecurityStatus,
  },
  {
    id: 'network',
    title: 'network',
    href: PopupPath.SETTINGS_NETWORK,
    useStatus: useNetworkStatus,
  },
  {
    id: 'zcash',
    title: 'zcash',
    href: PopupPath.SETTINGS_ZCASH_NETWORK,
    useStatus: useZcashStatus,
  },
  { id: 'people', title: 'people', href: PopupPath.SETTINGS_PEOPLE, useStatus: usePeopleStatus },
  {
    id: 'display',
    title: 'display',
    href: PopupPath.SETTINGS_DISPLAY,
    useStatus: useDisplayStatus,
  },
  {
    id: 'devices',
    title: 'wallets and devices',
    href: PopupPath.SETTINGS_DEVICES,
    useStatus: useDevicesStatus,
  },
];

/** each card subscribes only to its own status */
const GroupCard = ({ g }: { g: (typeof GROUPS)[number] }) => {
  const navigate = usePopupNav();
  const status = g.useStatus();
  const { mark, tone, tagline } = CATEGORY_MARKS[g.id];
  return (
    <button
      type='button'
      data-preload={g.href}
      onClick={() => navigate(g.href)}
      className='flex w-full items-center gap-3 border border-border-soft bg-elev-1 py-3 pl-3 pr-3.5 text-left transition-colors hover:bg-elev-2'
    >
      <span
        className={`grid size-9 shrink-0 place-items-center border border-border-hard font-display text-[17px] font-semibold ${tone}`}
        aria-hidden='true'
      >
        {mark}
      </span>
      <span className='flex min-w-0 grow flex-col gap-1'>
        <span className='flex items-baseline gap-2 whitespace-nowrap'>
          <span className='text-sm/[17px] text-fg-high'>{g.title}</span>
          <Clipped className='text-[11px] text-fg-dim'>{tagline}</Clipped>
        </span>
        <Clipped className='text-[11px]/[16px] text-fg-muted'>
          {status.text}
          {status.warn && <span className='text-warn'>{status.warn}</span>}
        </Clipped>
      </span>
      <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
    </button>
  );
};

/** settings index: six groups, each organised around who sees what. lock lives in the accounts sheet. */
export const Settings = () => (
  <SettingsScreen title='settings' backPath={false}>
    <div className='flex flex-col gap-2'>
      {GROUPS.map(g => (
        <GroupCard key={g.id} g={g} />
      ))}
      <p className='mt-1 text-center text-[11px] text-fg-dim'>
        zafu {chrome.runtime.getManifest().version} · rotko networks
      </p>
    </div>
  </SettingsScreen>
);
