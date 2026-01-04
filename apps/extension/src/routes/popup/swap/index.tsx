import { MixIcon } from '@radix-ui/react-icons';

export const SwapPage = () => {
  return (
    <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
      <div className='rounded-full bg-primary/10 p-4'>
        <MixIcon className='h-8 w-8 text-primary' />
      </div>
      <div>
        <h2 className='text-lg font-semibold'>Swap</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          Privately swap between assets using shielded pools.
        </p>
      </div>
      <p className='text-xs text-muted-foreground'>
        Available for Penumbra DEX and cross-chain swaps.
      </p>
    </div>
  );
};
