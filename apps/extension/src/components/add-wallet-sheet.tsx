/**
 * add wallet - grouped by custody, safest first. one hot wallet exists by
 * design (see state/keyring), so there is no "new seed phrase" row here -
 * only the doors that add a wallet whose key is NOT a second seed in this
 * browser: an air-gapped signer, a hardware wallet, or a read-only viewing
 * key.
 */

import { useNavigate } from 'react-router-dom';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { PopupPath } from '../routes/popup/paths';
import { PagePath } from '../routes/page/paths';
import { openPageInTab } from '../utils/popup-detection';
import { screenTransition } from '../utils/navigate';

interface AddWalletOption {
  icon: string;
  label: string;
  desc: string;
  path?: string;
  /** a page route that opens in a tab (WebHID dies with the popup) */
  tab?: true;
}

const KEYS_ELSEWHERE: AddWalletOption[] = [
  {
    icon: 'i-ph-qr-code',
    label: 'zigner',
    desc: 'scan its connect code - sign by qr',
    path: PopupPath.SETTINGS_ZIGNER,
  },
  {
    icon: 'i-ph-usb',
    label: 'ledger',
    desc: 'hardware wallet - usb',
    path: PagePath.CONNECT_LEDGER,
    tab: true,
  },
];

const WATCH_ONLY: AddWalletOption[] = [
  {
    icon: 'i-ph-eye',
    label: 'viewing key',
    desc: "see balance and history - can't spend",
    path: PopupPath.SETTINGS_ADD_VIEWING_KEY,
  },
];

const OptionGroup = ({
  title,
  options,
  onPick,
}: {
  title: string;
  options: AddWalletOption[];
  onPick: (opt: AddWalletOption) => void;
}) => (
  <div className='flex flex-col gap-2'>
    <p className='kicker'>{title}</p>
    <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
      {options.map(opt => (
        <button
          key={opt.label}
          type='button'
          disabled={!opt.path}
          onClick={() => opt.path && onPick(opt)}
          className={cn(
            'flex min-h-[52px] items-center gap-3 px-3.5 py-2 text-left transition-colors',
            opt.path ? 'hover:bg-surface-elev-2' : 'opacity-50',
          )}
        >
          <span className={cn(opt.icon, 'size-5 shrink-0 text-fg-muted')} aria-hidden='true' />
          <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
            <span className='text-data text-fg-high lowercase'>{opt.label}</span>
            <span className='text-label text-fg-muted lowercase'>{opt.desc}</span>
          </span>
          {opt.path && (
            <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
          )}
        </button>
      ))}
    </div>
  </div>
);

export const AddWalletSheet = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const navigate = useNavigate();

  const go = ({ path, tab }: AddWalletOption) => {
    onOpenChange(false);
    if (tab) {
      void openPageInTab(path!, true);
    } else {
      navigate(path!, screenTransition('push'));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='add wallet'>
      <div className='flex flex-col gap-4'>
        <OptionGroup title='keys elsewhere - safest' options={KEYS_ELSEWHERE} onPick={go} />
        <OptionGroup title='watch only' options={WATCH_ONLY} onPick={go} />
        {/* hot wallet: exactly one exists by design - a disabled row says so
            rather than silently offering nothing. */}
        <div className='flex flex-col gap-2'>
          <p className='kicker'>keys on this device</p>
          <div className='flex min-h-[52px] items-center gap-3 border border-surface-border-soft px-3.5 py-2 opacity-50'>
            <span className='i-zafu-hi size-5 shrink-0 text-fg-muted' aria-hidden='true' />
            <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
              <span className='text-data text-fg-high lowercase'>recovery phrase</span>
              <span className='text-label text-fg-muted lowercase'>
                wallet 1 already lives here
              </span>
            </span>
          </div>
        </div>
      </div>
    </Sheet>
  );
};
