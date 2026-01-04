import { ClockIcon } from '@radix-ui/react-icons';

export const HistoryPage = () => {
  return (
    <div className='flex flex-col items-center justify-center gap-4 p-6 pt-16 text-center'>
      <div className='rounded-full bg-primary/10 p-4'>
        <ClockIcon className='h-8 w-8 text-primary' />
      </div>
      <div>
        <h2 className='text-lg font-semibold'>Transaction History</h2>
        <p className='mt-1 text-sm text-muted-foreground'>
          View your past transactions across all networks.
        </p>
      </div>
      <p className='text-xs text-muted-foreground'>
        Your transaction history will appear here once available.
      </p>
    </div>
  );
};
