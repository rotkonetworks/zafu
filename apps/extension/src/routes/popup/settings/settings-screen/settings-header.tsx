import { BackIcon } from '@repo/ui/components/ui/icons/back-icon';
import { usePopupNav } from '../../../../utils/navigate';
import { PopupPath } from '../../paths';

export const SettingsHeader = ({ title }: { title: string }) => {
  const navigate = usePopupNav();
  return (
    <div className='flex h-[70px] items-center border-b border-border-secondary px-4'>
      <BackIcon
        className='size-5 shrink-0 text-foreground'
        onClick={() => navigate(PopupPath.INDEX)}
      />
      <h1 className='flex-1 text-center font-headline text-xl font-semibold leading-[30px] pr-5'>
        {title}
      </h1>
    </div>
  );
};
