import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { MOVED } from '../state/moved-notice';

/** board StMigrate: what the redesign moved, once, with a way to the accounts */
export const MovedSheet = ({
  open,
  onDone,
  onAccounts,
}: {
  open: boolean;
  onDone: () => void;
  onAccounts: () => void;
}) => (
  <Sheet open={open} onOpenChange={next => !next && onDone()} title='a few things moved'>
    <div className='flex flex-col gap-3'>
      <ul className='flex flex-col divide-y divide-border-soft border border-border-soft bg-canvas'>
        {MOVED.map(line => (
          <li key={line} className='flex h-12 items-center px-3.5 text-[13px] text-fg-high'>
            {line}
          </li>
        ))}
      </ul>
      <div className='flex gap-2 pt-0.5'>
        <Button variant='secondary' className='w-[130px] text-[13px]' onClick={onAccounts}>
          see accounts
        </Button>
        <Button className='grow' onClick={onDone}>
          understood
        </Button>
      </div>
    </div>
  </Sheet>
);
