import { Button } from '@repo/ui/components/ui/button';
import { useWindowCountdown } from './use-window-countdown';

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
  // when `wait` is provided, count whole seconds from it (approve disabled for
  // `wait` seconds). when omitted, keep the historical 0.5s / 500ms fat-finger
  // guard so unrelated approval screens are unchanged.
  const count = useWindowCountdown(wait ?? 0.5, wait != null ? 1000 : 500);

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
          disabled={!approve || count > 0}
        >
          {approveLabel}
        </Button>
      </div>
      {ignore && (
        <Button className='w-full py-2 text-base' size='sm' variant='quiet' onClick={ignore}>
          ignore site
        </Button>
      )}
    </div>
  );
};
