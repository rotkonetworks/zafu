import { nameVerified, payLink, type Offer } from '../../buy/fees';
import { payApp } from '../../buy/apps';
import { cn } from '@repo/ui/lib/utils';

/** whether zafu could check this seller's name against Peer's on-chain record */
export const NameTag = ({ o }: { o: Offer }) =>
  o.handle ? (
    nameVerified(o) ? (
      <span
        className='text-[11px] text-green'
        title="the name matches the seller's record on chain"
      >
        verified
      </span>
    ) : (
      <span className='text-[11px] text-warn' title="the name can't be checked on chain">
        not verified
      </span>
    )
  ) : null;

/** for a name zafu can't check: why, and where to see who it really is */
export const NameCheck = ({ o, className }: { o: Offer; className?: string }) => {
  if (!o.handle || nameVerified(o)) {
    return null;
  }
  const app = payApp(o.platform)?.name ?? o.platform;
  const link = payLink(o.platform, o.handle);
  return (
    <span className={cn('text-xs leading-relaxed text-warn', className)}>
      {app} keeps its account ids private, so zafu can't check {o.handle} against the seller's
      record on chain the way it does for other apps. peer gave this name; if it were wrong, money
      sent to it couldn't be taken back.
      {link && (
        <>
          {' '}
          check whose account it is first:{' '}
          <a href={link} target='_blank' rel='noopener noreferrer' className='underline'>
            {link.replace('https://', '')}
          </a>
        </>
      )}
    </span>
  );
};
