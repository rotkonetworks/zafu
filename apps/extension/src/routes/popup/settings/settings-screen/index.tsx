import { SettingsHeader } from './settings-header';
import { ReactNode } from 'react';
import { PopupPath } from '../../paths';

export const SettingsScreen = ({
  title,
  children,
  backPath,
}: {
  title: string;
  children: ReactNode;
  backPath?: PopupPath;
}) => {
  return (
    <div className='flex min-h-full w-full flex-col'>
      <SettingsHeader title={title} backPath={backPath} />
      <div className='flex grow flex-col px-4 pb-4 pt-4'>{children}</div>
    </div>
  );
};
