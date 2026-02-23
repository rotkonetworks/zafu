import { ExitIcon, FileTextIcon, GlobeIcon, Link1Icon, InfoCircledIcon, TrashIcon, EyeClosedIcon } from '@radix-ui/react-icons';
import { CustomLink } from '../../../shared/components/link';
import { useStore } from '../../../state';
import { passwordSelector } from '../../../state/password';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { SettingsScreen } from './settings-screen';

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

export const Settings = () => {
  const navigate = usePopupNav();
  const { clearSessionPassword } = useStore(passwordSelector);

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
