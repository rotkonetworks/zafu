import { SettingsHeader } from './settings-header';
import { ReactNode } from 'react';
import { PopupPath } from '../../paths';

export const SettingsScreen = ({
  title,
  children,
  backPath,
  onBack,
}: {
  title: string;
  children: ReactNode;
  backPath?: PopupPath;
  /** overrides back-arrow behavior (e.g. to confirm before leaving a live session). */
  onBack?: () => void;
}) => {
  return (
    <div className='flex min-h-full w-full flex-col'>
      <SettingsHeader title={title} backPath={backPath} onBack={onBack} />
      <div className='flex grow flex-col px-4 pb-4 pt-4'>{children}</div>
    </div>
  );
};
