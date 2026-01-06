/**
 * multi-network send screen
 */

import { useNavigate } from 'react-router-dom';
import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { useStore } from '../../../state';
import { activeNetworkSelector } from '../../../state/active-network';

export function SendPage() {
  const navigate = useNavigate();
  const { activeNetwork } = useStore(activeNetworkSelector);

  const goBack = () => navigate(-1);

  return (
    <div className='flex flex-col'>
      {/* Header */}
      <div className='flex items-center gap-3 border-b border-border/40 px-4 py-3'>
        <button
          onClick={goBack}
          className='text-muted-foreground transition-colors duration-75 hover:text-foreground'
        >
          <ArrowLeftIcon className='h-5 w-5' />
        </button>
        <h1 className='text-lg font-medium text-foreground'>send {activeNetwork}</h1>
      </div>

      {/* Content */}
      <div className='flex flex-col gap-4 p-4'>
        <div>
          <label className='mb-1 block text-xs text-muted-foreground'>recipient</label>
          <input
            type='text'
            placeholder='enter address'
            className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none'
          />
        </div>

        <div>
          <label className='mb-1 block text-xs text-muted-foreground'>amount</label>
          <input
            type='text'
            placeholder='0.00'
            className='w-full rounded-lg border border-border bg-input px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-100 focus:border-zigner-gold focus:outline-none'
          />
        </div>

        <button className='mt-4 w-full rounded-lg bg-zigner-gold py-3 text-sm font-medium text-zigner-dark transition-all duration-100 hover:bg-zigner-gold-light active:scale-[0.99]'>
          continue
        </button>

        <p className='text-center text-xs text-muted-foreground'>
          {activeNetwork === 'penumbra' && 'uses minifront for transaction building'}
          {activeNetwork === 'zcash' && 'requires zigner zafu for signing'}
          {activeNetwork === 'polkadot' && 'light client transaction'}
          {activeNetwork === 'cosmos' && 'coming soon'}
        </p>
      </div>
    </div>
  );
}

export default SendPage;
