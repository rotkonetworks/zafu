import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons';

const MAX_ACCOUNT = 2 ** 24;

function accountLabel(index: number): string {
  return index === 0 ? 'Main Account' : `Sub-Account #${index}`;
}

export function PenumbraAccountPicker({
  account,
  onChange,
}: {
  account: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className='flex items-center justify-center gap-1'>
      <button
        disabled={account <= 0}
        onClick={() => onChange(account - 1)}
        className='p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30'
      >
        <ChevronLeftIcon className='h-4 w-4' />
      </button>
      <span className='min-w-[110px] text-center text-xs font-medium text-muted-foreground'>
        {accountLabel(account)}
      </span>
      <button
        disabled={account >= MAX_ACCOUNT}
        onClick={() => onChange(account + 1)}
        className='p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30'
      >
        <ChevronRightIcon className='h-4 w-4' />
      </button>
    </div>
  );
}
