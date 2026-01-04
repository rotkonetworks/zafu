import { Outlet, useLocation } from 'react-router-dom';
import { usePopupReady } from '../../hooks/popup-ready';
import { BottomTabs, BOTTOM_TABS_HEIGHT } from '../../components/bottom-tabs';
import { PopupPath } from './paths';
import {
  HomeIcon,
  StackIcon,
  MixIcon,
  ClockIcon,
  GearIcon,
} from '@radix-ui/react-icons';

const mainTabs = [
  { path: PopupPath.INDEX, icon: <HomeIcon className='h-5 w-5' />, label: 'Home' },
  { path: PopupPath.STAKE, icon: <StackIcon className='h-5 w-5' />, label: 'Stake' },
  { path: PopupPath.SWAP, icon: <MixIcon className='h-5 w-5' />, label: 'Swap' },
  { path: PopupPath.HISTORY, icon: <ClockIcon className='h-5 w-5' />, label: 'History' },
  { path: PopupPath.SETTINGS, icon: <GearIcon className='h-5 w-5' />, label: 'Settings' },
];

// Routes where bottom tabs should NOT be shown
const hiddenTabRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SEND,
  PopupPath.RECEIVE,
];

export const PopupLayout = () => {
  usePopupReady();
  const location = useLocation();

  // Hide tabs on login, approval, and transaction pages
  const showTabs = !hiddenTabRoutes.some(
    route => location.pathname === route || location.pathname.startsWith(route + '/')
  );

  return (
    <div className='relative flex grow flex-col bg-card-radial'>
      <div
        className='flex-1 overflow-y-auto'
        style={{ paddingBottom: showTabs ? BOTTOM_TABS_HEIGHT : 0 }}
      >
        <Outlet />
      </div>
      {showTabs && <BottomTabs tabs={mainTabs} />}
    </div>
  );
};
