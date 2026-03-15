import {
  ExitIcon,
  FileTextIcon,
  GlobeIcon,
  Link1Icon,
  InfoCircledIcon,
  TrashIcon,
  EyeClosedIcon,
  ChevronRightIcon,
  PersonIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { selectActiveNetwork } from '../../../state/keyring';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import type { ReactElement } from 'react';

interface SettingsLink {
  title: string;
  icon: ReactElement;
  href: PopupPath;
  /** which networks show this link. undefined = always visible */
  networks?: string[];
}

const links: SettingsLink[] = [
  {
    title: 'Wallets',
    icon: <PersonIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_WALLETS,
  },
  {
    title: 'Recovery Passphrase',
    icon: <FileTextIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
  },
  {
    title: 'Network Endpoints',
    icon: <GlobeIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_NETWORK_ENDPOINTS,
  },
  {
    title: 'Connected Sites',
    icon: <Link1Icon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_CONNECTED_SITES,
    networks: ['penumbra'],
  },
  {
    title: 'Privacy',
    icon: <EyeClosedIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_PRIVACY,
  },
  {
    title: 'Clear Cache',
    icon: <TrashIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_CLEAR_CACHE,
  },
  {
    title: 'About',
    icon: <InfoCircledIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_ABOUT,
  },
];

function SettingsRow({
  icon,
  title,
  onClick,
}: {
  icon: ReactElement;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className='flex w-full items-center gap-3 py-3 text-left transition-colors duration-75 hover:bg-muted/30'
    >
      {icon}
      <span className='flex-1 text-sm text-foreground'>{title}</span>
      <ChevronRightIcon className='size-4 text-muted-foreground' />
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
    <SettingsScreen title='Settings' backPath={PopupPath.INDEX}>
      <div className='flex grow flex-col justify-between'>
        <div className='flex flex-col divide-y divide-border/30'>
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
            icon={<ExitIcon className='size-5 text-muted-foreground' />}
            title='Lock Wallet'
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
