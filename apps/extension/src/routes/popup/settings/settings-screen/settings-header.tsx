import { useBackNav } from '../../../../utils/navigate';
import { PopupPath } from '../../paths';

export const SettingsHeader = ({
  title,
  backPath,
  onBack,
}: {
  title: string;
  /** Fallback only — used when this screen is the session's entry point
   *  (deep link / dedicated window). With in-app history, back follows
   *  the route the user actually came from. */
  backPath?: PopupPath;
  /** overrides the default back navigation entirely when provided. */
  onBack?: () => void;
}) => {
  const goBack = useBackNav(backPath ?? PopupPath.SETTINGS);

  return (
    <div className='flex items-center gap-3 border-b border-border-soft px-4 py-3'>
      <button
        onClick={onBack ?? goBack}
        className='text-fg-muted transition-colors hover:text-fg-high'
      >
        <span className='i-lucide-arrow-left h-5 w-5' />
      </button>
      <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>{title}</h1>
    </div>
  );
};
