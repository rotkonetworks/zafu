import { FadeTransition } from '@repo/ui/components/ui/fade-transition';
import { useStore } from '../../../state';
import { originApprovalSelector } from '../../../state/origin-approval';
import { ApproveDeny } from './approve-deny';
import { LinkGradientIcon } from '../../../icons/link-gradient';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { cn } from '@repo/ui/lib/utils';
import { UserChoice } from '@repo/storage-chrome/records';
import { CAPABILITY_META, type Capability, type RiskLevel } from '@repo/storage-chrome/capabilities';

const riskStyles: Record<RiskLevel, { border: string; bg: string; text: string; banner?: string }> = {
  low: {
    border: 'border-border-soft',
    bg: '',
    text: 'text-fg-muted',
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

const CapabilityItem = ({ cap }: { cap: Capability }) => {
  const meta = CAPABILITY_META[cap];
  const style = riskStyles[meta.risk];

  return (
    <div className={cn('rounded-lg border p-3', style.border, style.bg)}>
      {style.banner && (
        <div className={cn('mb-2 text-xs font-medium', style.text)}>
          {style.banner}
        </div>
      )}
      <div className='flex items-center gap-2'>
        <span className={cn('text-sm font-medium', style.text)}>{meta.label}</span>
        <span className={cn(
          'rounded px-1.5 py-0.5 text-[10px] uppercase',
          meta.risk === 'low' && 'bg-elev-2 text-fg-muted',
          meta.risk === 'medium' && 'bg-yellow-500/10 text-yellow-400',
          meta.risk === 'high' && 'bg-orange-500/10 text-orange-400',
          meta.risk === 'critical' && 'bg-red-500/10 text-red-400',
        )}>
          {meta.risk}
        </span>
      </div>
      <p className='mt-1 text-xs text-fg-muted'>{meta.description}</p>
    </div>
  );
};

export const OriginApproval = () => {
  const { requestOrigin, favIconUrl, title, lastRequest, requestedCapabilities, setChoice, sendResponse } =
    useStore(originApprovalSelector);

  const approve = () => {
    setChoice(UserChoice.Approved);
    sendResponse();
    window.close();
  };

  const deny = () => {
    setChoice(UserChoice.Denied);
    sendResponse();
    window.close();
  };

  const ignore = () => {
    setChoice(UserChoice.Ignored);
    sendResponse();
    window.close();
  };

  if (!requestOrigin) {
    return null;
  }

  // determine highest risk level for banner
  const maxRisk = requestedCapabilities.reduce<RiskLevel>((max, cap) => {
    const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const capRisk = CAPABILITY_META[cap].risk;
    return levels.indexOf(capRisk) > levels.indexOf(max) ? capRisk : max;
  }, 'low');

  return (
    <FadeTransition>
      <div className='flex min-h-screen w-screen flex-col gap-6'>
        <h1 className='flex h-[70px] items-center justify-center border-b border-border-soft font-headline text-xl font-medium leading-[30px]'>
          Connect
        </h1>
        <div className='mx-auto size-20'>
          <LinkGradientIcon />
        </div>
        <div className='w-full px-[30px]'>
          <div className='flex flex-col gap-2'>
            <div
              className={cn(
                'rounded-[1em]',
                'border-[1px]',
                'border-transparent',
                'p-2',
                '[background:linear-gradient(var(--charcoal),var(--charcoal))_padding-box,_linear-gradient(to_bottom_left,rgb(139,228,217),rgb(255,144,47))_border-box]',
              )}
            >
              <div className='flex flex-col items-center gap-2'>
                <div className='flex h-11 max-w-full items-center rounded-lg bg-black p-2 text-fg-muted [z-index:30]'>
                  {!!favIconUrl && (
                    <div
                      className={cn(
                        '-ml-3',
                        'relative',
                        'rounded-full',
                        'border-[1px]',
                        'border-transparent',
                        '[background:linear-gradient(var(--charcoal),var(--charcoal))_padding-box,_linear-gradient(to_top_right,rgb(139,228,217),rgb(255,144,47))_border-box]',
                      )}
                    >
                      <img
                        src={favIconUrl}
                        alt='requesting website icon'
                        className='size-20 min-w-20 rounded-full'
                      />
                    </div>
                  )}
                  <div className='-ml-3 w-full truncate p-2 pl-6 font-headline text-lg'>
                    {title ? (
                      <span className='text-zigner-dark'>{title}</span>
                    ) : (
                      <span className='text-fg-muted underline decoration-dotted decoration-2 underline-offset-4'>
                        no title
                      </span>
                    )}
                  </div>
                </div>
                <div className='z-30 flex min-h-11 w-full items-center overflow-x-auto rounded-lg bg-canvas p-2 text-fg-muted'>
                  <div className='mx-auto items-center p-2 text-center leading-[0.8em]'>
                    <DisplayOriginURL url={new URL(requestOrigin)} />
                  </div>
                </div>
              </div>
            </div>

            {/* capability list with risk styling */}
            <div className='mt-3 flex flex-col gap-2'>
              <p className='text-sm text-fg-muted'>
                this site is requesting the following permissions:
              </p>
              {requestedCapabilities.map(cap => (
                <CapabilityItem key={cap} cap={cap} />
              ))}
            </div>

            {/* extra warning for high/critical */}
            {(maxRisk === 'high' || maxRisk === 'critical') && (
              <div className={cn(
                'mt-2 rounded-lg border p-3 text-xs',
                maxRisk === 'critical'
                  ? 'border-red-500/50 bg-red-500/10 text-red-400'
                  : 'border-orange-500/40 bg-orange-500/5 text-orange-400',
              )}>
                review these permissions carefully before approving.
                {maxRisk === 'critical' && ' this includes dangerous capabilities.'}
              </div>
            )}

            <p className='mt-1 text-xs text-fg-muted'>
              your viewing keys stay local - they never leave the extension.
            </p>
          </div>
        </div>
        <div className='flex grow flex-col justify-end'>
          <ApproveDeny approve={approve} deny={deny} ignore={lastRequest && ignore} />
        </div>
      </div>
    </FadeTransition>
  );
};
