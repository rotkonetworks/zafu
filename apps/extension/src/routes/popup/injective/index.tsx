/**
 * Injective account: the user's Injective addresses (HD, a fresh one per
 * open), their balances, moving funds into Penumbra and sending them out.
 * Its own screen - it used to be a tab inside Receive.
 */

import { PopupPath } from '../paths';
import { useBackNav } from '../../../utils/navigate';
import { InjectiveAccount } from './account';

export const InjectivePage = () => {
  const goBack = useBackNav(PopupPath.INDEX);
  return (
    <div className='flex h-full flex-col'>
      <div className='flex shrink-0 items-center gap-3 border-b border-border-soft px-4 py-3'>
        <button
          onClick={goBack}
          className='text-fg-muted transition-colors hover:text-fg-high'
          aria-label='back'
        >
          <span className='i-ph-arrow-left h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-fg'>injective</h1>
      </div>
      <div className='flex-1 overflow-y-auto p-4'>
        <InjectiveAccount />
      </div>
    </div>
  );
};

export default InjectivePage;
