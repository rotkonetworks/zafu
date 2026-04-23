import { useState, useEffect } from 'react';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { selectActiveNetwork } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
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

const links: SettingsLink[] = [
  {
    title: 'pro subscription',
    icon: 'i-lucide-zap',
    href: PopupPath.SUBSCRIBE,
  },
  {
    title: 'recovery passphrase',
    icon: 'i-lucide-file-text',
    href: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
  },
  {
    title: 'privacy',
    icon: 'i-lucide-eye-off',
    href: PopupPath.SETTINGS_PRIVACY,
  },
  {
    title: 'clear cache',
    icon: 'i-lucide-trash-2',
    href: PopupPath.SETTINGS_CLEAR_CACHE,
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
      className='flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-elev-1'
    >
      <span className={cn(icon, 'size-5 text-fg-muted')} />
      <span className='flex-1 text-sm text-fg'>{title}</span>
      <span className='i-lucide-chevron-right size-4 text-fg-muted' />
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

  const visibleLinks = links.filter(
    l => !l.networks || l.networks.includes(activeNetwork),
  );

  const autoLockLabel = AUTO_LOCK_OPTIONS.find(o => o.value === autoLock)?.label ?? '15 min';

  return (
    <SettingsScreen title='settings' backPath={PopupPath.INDEX}>
      <div className='flex grow flex-col justify-between'>
        <div className='flex flex-col divide-y divide-border/40'>
          {visibleLinks.map(l => (
            <SettingsRow
              key={l.href}
              icon={l.icon}
              title={l.title}
              onClick={() => navigate(l.href)}
            />
          ))}
          <button
            onClick={cycleAutoLock}
            className='flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-elev-1'
          >
            <span className={cn('i-lucide-timer', 'size-5 text-fg-muted')} />
            <span className='flex-1 text-sm text-fg'>auto-lock</span>
            <span className='text-xs text-fg-muted'>{autoLockLabel}</span>
          </button>
        </div>

        <div className='mt-4 border-t border-border-hard-soft pt-4'>
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
