import { Fragment, useState, useEffect } from 'react';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { selectActiveNetwork } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SUBSCRIBE_ENABLED } from '../../../config/feature-flags';
import { SettingsScreen } from './settings-screen';
import { cn } from '@repo/ui/lib/utils';
import { localExtStorage } from '@repo/storage-chrome/local';

interface SettingsLink {
  title: string;
  icon: string;
  href: PopupPath;
  /** which networks show this link. undefined = always visible */
  networks?: string[];
}

interface SettingsGroup {
  /** lowercase kicker header for the group */
  label: string;
  links: SettingsLink[];
}

// Grouped by intent: what protects funds first (security & backup, with
// auto-lock rendered inline in that group), then privacy, then wallet
// plumbing (networks, zigner), then about. Lock stays pinned at the
// bottom where muscle memory can't hit it by accident.
//
// TODO(orphan): link or delete - settings-rpc, settings-numeraires,
// settings-trading-mode, and settings-parachains have screens but no route
// and no nav-in. Decide whether they should be reachable or removed.
const groups: SettingsGroup[] = [
  {
    label: 'security & backup',
    links: [
      {
        title: 'recovery passphrase',
        icon: 'i-lucide-file-text',
        href: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
      },
      {
        title: 'multisig backup',
        icon: 'i-lucide-shield',
        href: PopupPath.SETTINGS_MULTISIG_BACKUP,
        networks: ['zcash'],
      },
      // auto-lock renders here as an inline control (see below)
      {
        title: 'clear cache',
        icon: 'i-lucide-trash-2',
        href: PopupPath.SETTINGS_CLEAR_CACHE,
      },
    ],
  },
  {
    label: 'privacy',
    links: [
      {
        title: 'privacy',
        icon: 'i-lucide-eye-off',
        href: PopupPath.SETTINGS_PRIVACY,
      },
      {
        title: 'connected sites',
        icon: 'i-lucide-globe',
        href: PopupPath.SETTINGS_CONNECTED_SITES,
      },
    ],
  },
  {
    label: 'wallet',
    links: [
      {
        title: 'networks',
        icon: 'i-lucide-network',
        href: PopupPath.SETTINGS_NETWORKS,
      },
      {
        title: 'zigner',
        icon: 'i-lucide-qr-code',
        href: PopupPath.SETTINGS_ZIGNER,
      },
    ],
  },
  {
    label: 'about',
    links: [
      ...(SUBSCRIBE_ENABLED
        ? [
            {
              title: 'pro subscription',
              icon: 'i-lucide-zap',
              href: PopupPath.SUBSCRIBE,
            },
          ]
        : []),
      {
        title: 'about',
        icon: 'i-lucide-info',
        href: PopupPath.SETTINGS_ABOUT,
      },
    ],
  },
];

function SettingsRow({
  icon,
  title,
  onClick,
}: {
  icon: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className='flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elev-1 hover:text-fg-high group'
    >
      <span className={cn(icon, 'size-5 text-fg-muted group-hover:text-fg-high')} />
      <span className='flex-1 text-data text-fg group-hover:text-fg-high lowercase'>{title}</span>
      <span className='i-lucide-chevron-right size-4 text-fg-dim group-hover:text-fg-muted' />
    </button>
  );
}

const AUTO_LOCK_OPTIONS = [
  { label: 'disabled', value: 0 },
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
];

export const Settings = () => {
  const navigate = usePopupNav();
  const { clearSessionPassword } = useStore(passwordSelector);
  const activeNetwork = useStore(selectActiveNetwork);
  const [autoLock, setAutoLock] = useState(15);

  useEffect(() => {
    void localExtStorage.get('autoLockMinutes').then(v => setAutoLock(v ?? 15));
  }, []);

  const cycleAutoLock = () => {
    const idx = AUTO_LOCK_OPTIONS.findIndex(o => o.value === autoLock);
    const next = AUTO_LOCK_OPTIONS[(idx + 1) % AUTO_LOCK_OPTIONS.length]!;
    setAutoLock(next.value);
    void localExtStorage.set('autoLockMinutes', next.value);
  };

  const visibleGroups = groups
    .map(g => ({
      ...g,
      links: g.links.filter(l => !l.networks || l.networks.includes(activeNetwork)),
    }))
    .filter(g => g.links.length > 0);

  const autoLockLabel = AUTO_LOCK_OPTIONS.find(o => o.value === autoLock)?.label ?? '15 min';

  return (
    <SettingsScreen title='settings' backPath={PopupPath.INDEX}>
      <div className='flex grow flex-col justify-between'>
        <div className='flex flex-col gap-4'>
          {visibleGroups.map(group => (
            <div key={group.label}>
              <p className='kicker px-4 pb-1'>{group.label}</p>
              <div className='flex flex-col divide-y divide-border-soft/40'>
                {group.links.map(l => (
                  <Fragment key={l.href}>
                    {/* auto-lock lives with the security controls, before clear cache */}
                    {group.label === 'security & backup' && l.title === 'clear cache' && (
                      <button
                        onClick={cycleAutoLock}
                        className='flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elev-1 hover:text-fg-high group'
                      >
                        <span
                          className={cn(
                            'i-lucide-timer',
                            'size-5 text-fg-muted group-hover:text-fg-high',
                          )}
                        />
                        <span className='flex-1 text-data text-fg group-hover:text-fg-high lowercase'>
                          auto-lock
                        </span>
                        <span className='text-label tabular text-fg-dim group-hover:text-fg-muted'>
                          {autoLockLabel}
                        </span>
                      </button>
                    )}
                    <SettingsRow icon={l.icon} title={l.title} onClick={() => navigate(l.href)} />
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className='mt-4 border-t border-border-soft pt-4'>
          <SettingsRow
            icon='i-lucide-log-out'
            title='lock wallet'
            onClick={() => {
              clearSessionPassword();
              chrome.runtime.reload();
            }}
          />
        </div>
      </div>
    </SettingsScreen>
  );
};
