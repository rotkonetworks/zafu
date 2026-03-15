import { usePopupNav } from '../../../../utils/navigate';
import { PopupPath } from '../../paths';

export const SettingsHeader = ({
  title,
  backPath,
}: {
  title: string;
  backPath?: PopupPath;
}) => {
  const navigate = usePopupNav();
  const target = backPath ?? PopupPath.SETTINGS;

  return (
    <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
      <button
        onClick={() => navigate(target)}
        className='text-muted-foreground transition-colors hover:text-foreground'
      >
        <span className='i-lucide-arrow-left h-5 w-5' />
      </button>
      <h1 className='text-lg font-medium text-foreground'>{title}</h1>
    </div>
  );
};
