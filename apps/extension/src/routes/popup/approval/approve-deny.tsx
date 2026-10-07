import { Button } from '@repo/ui/components/ui/button';
import { useApproveGuard } from './use-approve-guard';

export const ApproveDeny = ({
  approve,
  deny,
  ignore,
  wait,
  approveLabel = 'approve',
  denyLabel = 'no, thank you',
}: {
  approve?: () => void;
  deny: () => void;
  ignore?: () => void;
  wait?: number;
  approveLabel?: string;
  denyLabel?: string;
}) => {
  // `wait` seconds is a deliberate pause (foilhat, zcash send); without it,
  // half a second against a fat-fingered double click
  const ready = useApproveGuard(wait ?? 0.5);

  return (
    <div className='flex shrink-0 flex-col gap-2 border-t border-border-soft bg-canvas px-4 py-4'>
      <div className='flex flex-row gap-3'>
        <Button variant='secondary' className='w-1/2 py-3.5 text-base' size='md' onClick={deny}>
          {denyLabel}
        </Button>
        <Button
          variant='primary'
          className='w-1/2 py-3.5 text-base'
          size='md'
          onClick={approve}
          disabled={!approve || !ready}
        >
          {approveLabel}
        </Button>
      </div>
      {ignore && (
        <Button className='w-full py-2 text-base' size='sm' variant='quiet' onClick={ignore}>
          don't ask again
        </Button>
      )}
    </div>
  );
};
