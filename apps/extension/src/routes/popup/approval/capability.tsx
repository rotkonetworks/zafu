import { useSearchParams } from 'react-router-dom';
import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { CAPABILITY_META, type Capability, type RiskLevel } from '@repo/storage-chrome/capabilities';
import { cn } from '@repo/ui/lib/utils';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { LinkGradientIcon } from '../../../icons/link-gradient';

const riskStyles: Record<RiskLevel, { border: string; bg: string; text: string; banner?: string }> = {
  low: {
    border: 'border-border/40',
    bg: '',
    text: 'text-muted-foreground',
  },
  medium: {
    border: 'border-yellow-500/30',
    bg: 'bg-yellow-500/5',
    text: 'text-yellow-400',
  },
  high: {
    border: 'border-orange-500/40',
    bg: 'bg-orange-500/5',
    text: 'text-orange-400',
    banner: 'This grants significant access to your wallet.',
  },
  critical: {
    border: 'border-red-500/50',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    banner: 'DANGER: This capability can sign transactions without your approval.',
  },
};

export const CapabilityApproval = () => {
  const [params] = useSearchParams();
  const origin = params.get('app') || '';
  const capability = params.get('capability') as Capability | null;
  const requestId = params.get('requestId') || '';
  const favIconUrl = params.get('favIconUrl') || '';
  const title = params.get('title') || '';

  if (!capability || !(capability in CAPABILITY_META)) {
    return <div className='p-4 text-red-400'>Invalid capability request</div>;
  }

  const meta = CAPABILITY_META[capability];
  const style = riskStyles[meta.risk];

  const respond = (approved: boolean) => {
    void chrome.runtime.sendMessage({
      type: 'zafu_capability_result',
      requestId,
      result: { approved },
    });
    window.close();
  };

  return (
    <FadeTransition>
      <div className='flex min-h-screen w-screen flex-col gap-6'>
        <h1 className='flex h-[70px] items-center justify-center border-b border-border/40 font-headline text-xl font-medium leading-[30px]'>
          Permission Request
        </h1>
        <div className='mx-auto size-20'>
          <LinkGradientIcon />
        </div>
        <div className='w-full px-[30px]'>
          <div className='flex flex-col gap-2'>
            {/* origin display */}
            <div className='flex items-center gap-2 rounded-lg bg-background p-3'>
              {!!favIconUrl && (
                <img src={favIconUrl} alt='' className='size-8 rounded-full' />
              )}
              <div className='flex flex-col overflow-hidden'>
                {title && <span className='text-sm truncate'>{title}</span>}
                {origin && (
                  <span className='text-xs text-muted-foreground truncate'>
                    <DisplayOriginURL url={new URL(origin)} />
                  </span>
                )}
              </div>
            </div>

            {/* capability card */}
            <div className={cn('rounded-lg border p-4', style.border, style.bg)}>
              {style.banner && (
                <div className={cn('mb-3 text-xs font-medium', style.text)}>
                  {style.banner}
                </div>
              )}
              <div className='flex items-center gap-2'>
                <span className={cn('text-base font-medium', style.text)}>{meta.label}</span>
                <span className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] uppercase',
                  meta.risk === 'low' && 'bg-muted text-muted-foreground',
                  meta.risk === 'medium' && 'bg-yellow-500/10 text-yellow-400',
                  meta.risk === 'high' && 'bg-orange-500/10 text-orange-400',
                  meta.risk === 'critical' && 'bg-red-500/10 text-red-400',
                )}>
                  {meta.risk}
                </span>
              </div>
              <p className='mt-2 text-sm text-muted-foreground'>{meta.description}</p>
            </div>

            {/* extra warning for critical */}
            {meta.risk === 'critical' && (
              <div className='rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-xs text-red-400'>
                Are you absolutely sure? This site will be able to sign transactions
                on your behalf without asking for confirmation.
              </div>
            )}
          </div>
        </div>
        <div className='flex grow flex-col justify-end'>
          <ApproveDeny approve={() => respond(true)} deny={() => respond(false)} />
        </div>
      </div>
    </FadeTransition>
  );
};
