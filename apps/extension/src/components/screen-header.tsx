import type { ReactNode } from 'react';
import { useBackNav } from '../utils/navigate';
import { PopupPath } from '../routes/popup/paths';

/** The one screen header: 56px, 40px back box, Mincho title, 1px line. */
export const ScreenHeader = ({
  title,
  backPath,
  onBack,
  meta,
}: {
  title: string;
  /** Fallback only - used when this screen is the session's entry point
   *  (deep link / dedicated window). With in-app history, back follows
   *  the route the user actually came from. `false` for a tab root. */
  backPath?: PopupPath | false;
  /** overrides the default back navigation entirely when provided. */
  onBack?: () => void;
  /** right-aligned, e.g. a step count */
  meta?: ReactNode;
}) => {
  const goBack = useBackNav(backPath || PopupPath.SETTINGS);

  return (
    <header
      className={`flex h-14 shrink-0 items-center gap-1 border-b border-border-soft pr-4 ${backPath === false ? 'pl-4' : 'pl-2'}`}
    >
      {backPath !== false && (
        <button
          onClick={onBack ?? goBack}
          aria-label='back'
          className='grid size-10 shrink-0 place-items-center text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high'
        >
          <span className='i-lucide-chevron-left size-[18px]' />
        </button>
      )}
      <h1 className='grow truncate font-display text-xl text-fg-high lowercase'>{title}</h1>
      {meta && <span className='flex items-center gap-2 text-[11px] text-fg-muted'>{meta}</span>}
    </header>
  );
};
