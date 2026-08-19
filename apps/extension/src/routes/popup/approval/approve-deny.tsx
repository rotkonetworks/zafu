import { Button } from '@repo/ui/components/ui/button';
import { useWindowCountdown } from './use-window-countdown';

export const ApproveDeny = ({
  approve,
  deny,
  ignore,
  wait,
}: {
  approve?: () => void;
  deny: () => void;
  ignore?: () => void;
  wait?: number;
}) => {
  // when `wait` is provided, count whole seconds from it (approve disabled for
  // `wait` seconds). when omitted, keep the historical 0.5s / 500ms fat-finger
  // guard so unrelated approval screens are unchanged.
  const count = useWindowCountdown(wait ?? 0.5, wait != null ? 1000 : 500);

  return (
    <div className='flex shrink-0 flex-row justify-between gap-4 rounded-lg bg-elev-1 px-4 py-7 shadow-lg'>
      <Button
        variant='gradient'
        className='w-1/2 py-3.5 text-base'
        size='lg'
        onClick={approve}
        disabled={!approve || count > 0}
      >
        approve
      </Button>
      <Button
        className='w-1/2 py-3.5 text-base hover:bg-destructive/90 transition-colors'
        size='lg'
        variant='destructiveSecondary'
        onClick={deny}
      >
        deny
      </Button>
      {ignore && (
        <Button
          className='w-1/2 py-3.5 text-base hover:bg-destructive/90'
          size='lg'
          variant='secondary'
          onClick={ignore}
        >
          ignore site
        </Button>
      )}
    </div>
  );
};
