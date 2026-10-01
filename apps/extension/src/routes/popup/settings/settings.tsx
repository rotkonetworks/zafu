import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../state';
import { selectEnabledNetworks } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { CATEGORY_MARKS, SettingsScreen, type SettingsCategory } from './settings-screen';
import { useAutoLock, AUTO_LOCK_OPTIONS } from './use-auto-lock';
import { useZafuTheme } from './settings-appearance';
import {
  devicesStatus,
  networksStatus,
  privacyStatus,
  securityStatus,
  selectConnectedSiteCount,
  selectPrivateDefaults,
  selectUnbackedSeatCount,
  selectZignerPaired,
} from './settings-status';

const useSecurityStatus = () => {
  const unbacked = useStore(selectUnbackedSeatCount);
  const { minutes } = useAutoLock();
  return securityStatus(
    unbacked,
    AUTO_LOCK_OPTIONS.find(o => o.value === minutes)?.label ?? `${minutes} min`,
  );
};

const usePrivacyStatus = () =>
  privacyStatus(useStore(selectPrivateDefaults), useStore(selectConnectedSiteCount));

const useNetworksStatus = () => networksStatus(useStore(useShallow(selectEnabledNetworks)));

const useDevicesStatus = () => devicesStatus(useStore(selectZignerPaired), useZafuTheme().theme);

const CATEGORIES: readonly {
  id: SettingsCategory;
  title: string;
  href: PopupPath;
  useStatus: () => string;
}[] = [
  {
    id: 'security',
    title: 'security',
    href: PopupPath.SETTINGS_SECURITY,
    useStatus: useSecurityStatus,
  },
  {
    id: 'privacy',
    title: 'privacy',
    href: PopupPath.SETTINGS_PRIVACY_HOME,
    useStatus: usePrivacyStatus,
  },
  {
    id: 'networks',
    title: 'networks',
    href: PopupPath.SETTINGS_NETWORKS_HOME,
    useStatus: useNetworksStatus,
  },
  {
    id: 'devices',
    title: 'devices and app',
    href: PopupPath.SETTINGS_DEVICES,
    useStatus: useDevicesStatus,
  },
];

/** each card subscribes only to its own status */
const CategoryCard = ({ c }: { c: (typeof CATEGORIES)[number] }) => {
  const navigate = usePopupNav();
  const status = c.useStatus();
  const { mark, tone } = CATEGORY_MARKS[c.id];
  return (
    <button
      type='button'
      onClick={() => navigate(c.href)}
      className='flex w-full items-center gap-3.5 border border-border-soft bg-elev-1 p-4 text-left transition-colors hover:bg-elev-2'
    >
      <span
        className={`grid size-9 shrink-0 place-items-center border border-border-hard font-display text-[17px] font-semibold ${tone}`}
        aria-hidden='true'
      >
        {mark}
      </span>
      <span className='flex min-w-0 grow flex-col gap-1'>
        <span className='text-sm/[17px] text-fg-high'>{c.title}</span>
        <span className='truncate text-[11px]/[16px] text-fg-muted'>{status}</span>
      </span>
      <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
    </button>
  );
};

/** settings index: the four category cards. lock lives in the accounts sheet. */
export const Settings = () => (
  <SettingsScreen title='settings' backPath={false}>
    <div className='flex flex-col gap-2.5'>
      {CATEGORIES.map(c => (
        <CategoryCard key={c.id} c={c} />
      ))}
      <p className='mt-1.5 text-center text-[11px] text-fg-dim'>
        zafu {chrome.runtime.getManifest().version} · rotko networks
      </p>
    </div>
  </SettingsScreen>
);
