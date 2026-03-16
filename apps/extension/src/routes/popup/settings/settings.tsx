import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { selectActiveNetwork } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { cn } from '@repo/ui/lib/utils';

interface SettingsLink {
  title: string;
  icon: string;
  href: PopupPath;
  /** which networks show this link. undefined = always visible */
  networks?: string[];
}

const links: SettingsLink[] = [
  {
    title: 'wallets',
    icon: 'i-lucide-user',
    href: PopupPath.SETTINGS_WALLETS,
  },
  {
    title: 'recovery passphrase',
    icon: 'i-lucide-file-text',
    href: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
  },
  {
    title: 'networks & endpoints',
    icon: 'i-lucide-globe',
    href: PopupPath.SETTINGS_NETWORKS,
  },
  {
    title: 'connected sites',
    icon: 'i-lucide-link',
    href: PopupPath.SETTINGS_CONNECTED_SITES,
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
  {
    title: 'about',
    icon: 'i-lucide-info',
    href: PopupPath.SETTINGS_ABOUT,
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
      className='flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-muted/50'
    >
      <span className={cn(icon, 'size-5 text-muted-foreground')} />
      <span className='flex-1 text-sm text-foreground'>{title}</span>
      <span className='i-lucide-chevron-right size-4 text-muted-foreground' />
    </button>
  );
}

export const Settings = () => {
  const navigate = usePopupNav();
  const { clearSessionPassword } = useStore(passwordSelector);
  const activeNetwork = useStore(selectActiveNetwork);

  const visibleLinks = links.filter(
    l => !l.networks || l.networks.includes(activeNetwork),
  );

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
        </div>

        <div className='mt-4 border-t border-border/40 pt-4'>
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
