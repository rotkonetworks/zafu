import { StackIcon } from '@radix-ui/react-icons';

export const StakePage = () => {
  return (
    <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
      <div className='rounded-full bg-primary/10 p-4'>
        <StackIcon className='h-8 w-8 text-primary' />
      </div>
      <div>
        <h2 className='text-lg font-semibold'>Staking</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          Stake your tokens to earn rewards and secure the network.
        </p>
      </div>
      <p className='text-xs text-muted-foreground'>
        Coming soon for Penumbra, Polkadot, and more.
      </p>
    </div>
  );
};
