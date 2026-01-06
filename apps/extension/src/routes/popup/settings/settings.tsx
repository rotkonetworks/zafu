import { DashboardIcon, ExitIcon, FileTextIcon, GlobeIcon, Link1Icon } from '@radix-ui/react-icons';
import { CustomLink } from '../../../shared/components/link';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';
import { useChainIdQuery } from '../../../hooks/chain-id';
import { useNumeraires } from '../../../hooks/numeraires-query';

const links = [
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
  },
  {
    title: 'Advanced',
    icon: <DashboardIcon className='size-5 text-muted-foreground' />,
    href: PopupPath.SETTINGS_ADVANCED,
  },
];

export const Settings = () => {
  const navigate = usePopupNav();
  const { clearSessionPassword } = useStore(passwordSelector);

  const { chainId } = useChainIdQuery();
  const { numeraires } = useNumeraires(chainId);

  return (
    <SettingsScreen title='Settings and Security'>
      <div className='flex grow flex-col justify-between'>
        <div className='flex flex-1 flex-col items-start gap-5'>
          {links.map(i => (
            <CustomLink
              key={i.href}
              title={i.title}
              icon={i.icon}
              onClick={() => navigate(i.href)}
              disabled={i.href === PopupPath.SETTINGS_NUMERAIRES && numeraires.length === 0}
            />
          ))}
        </div>

        <div className='mt-4 border-t border-border/50 pt-4'>
          <CustomLink
            title='Lock Wallet'
            icon={<ExitIcon className='size-5 text-muted-foreground' />}
            onClick={() => {
              clearSessionPassword();
              // Normally we could do: navigate(PopupPath.LOGIN)
              // However, for security reasons, we are reloading the window to guarantee
              // the password does not remain in memory. Auditors have not trusted that even though
              // it's cleared in Zustand that it could still be extracted somehow.
              chrome.runtime.reload();
            }}
          />
        </div>
      </div>
    </SettingsScreen>
  );
};
