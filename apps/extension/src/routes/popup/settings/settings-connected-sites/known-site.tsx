import { OriginRecord, UserChoice } from '@repo/storage-chrome/records';
import { Button } from '@repo/ui/components/ui/button';
import { DisplayOriginURL } from '../../../../shared/components/display-origin-url';

export const KnownSite = ({
  site,
  discard,
}: {
  site: OriginRecord;
  discard: (d: OriginRecord) => Promise<void>;
}) => {
  return (
    <div key={site.origin} role='listitem' className='flex items-center justify-between'>
      {site.choice === UserChoice.Approved && (
        <a href={site.origin} target='_blank' rel='noreferrer' className='truncate'>
          <DisplayOriginURL url={new URL(site.origin)} />
        </a>
      )}
      {site.choice === UserChoice.Denied && (
        <span className='truncate brightness-75'>
          <DisplayOriginURL url={new URL(site.origin)} />
        </span>
      )}
      {site.choice === UserChoice.Ignored && (
        <span className='truncate line-through decoration-red decoration-wavy brightness-75'>
          <DisplayOriginURL url={new URL(site.origin)} />
        </span>
      )}

      <div className='flex items-center gap-2'>
        <Button
          aria-description='Remove'
          className='h-auto bg-transparent'
          onClick={() => void discard(site)}
        >
          <span className='i-lucide-trash-2 h-4 w-4 text-muted-foreground' />
        </Button>
      </div>
    </div>
  );
};
