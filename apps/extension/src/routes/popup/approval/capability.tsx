import { useSearchParams } from 'react-router-dom';
import {
  CAPABILITY_META,
  type Capability,
  type RiskLevel,
} from '@repo/storage-chrome/capabilities';
import { cn } from '@repo/ui/lib/utils';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { LinkGradientIcon } from '../../../icons/link-gradient';

const riskStyles: Record<RiskLevel, { border: string; bg: string; text: string; banner?: string }> =
  {
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
      banner: 'this grants significant access to your wallet.',
    },
    critical: {
      border: 'border-red-500/50',
      bg: 'bg-red-500/10',
      text: 'text-red-400',
      banner: 'danger: this capability can sign transactions without your approval.',
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
    return <div className='p-4 text-red-400'>invalid capability request</div>;
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
    <ApprovalScreen
      header={
        <header className='flex h-[70px] flex-col items-center justify-center border-b border-border-soft'>
          <span className='kicker mb-1'>capability request</span>
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            permission request
          </h1>
        </header>
      }
      footer={<ApproveDeny approve={() => respond(true)} deny={() => respond(false)} />}
    >
      <div className='mx-auto size-20'>
        <LinkGradientIcon />
      </div>
      <div className='w-full px-[30px]'>
        <div className='flex flex-col gap-2'>
          {/* origin display */}
          <div className='flex items-center gap-2 rounded-lg bg-canvas p-3'>
            {!!favIconUrl && <img src={favIconUrl} alt='' className='size-8 rounded-full' />}
            <div className='flex flex-col overflow-hidden'>
              {title && <span className='text-sm truncate'>{title}</span>}
              {origin && (
                <span className='text-xs text-fg-muted truncate'>
                  <DisplayOriginURL url={new URL(origin)} />
                </span>
              )}
            </div>
          </div>

          {/* capability card */}
          <div className={cn('rounded-lg border p-4', style.border, style.bg)}>
            {style.banner && (
              <div className={cn('mb-3 text-xs font-medium', style.text)}>{style.banner}</div>
            )}
            <div className='flex items-center gap-2'>
              <span className={cn('text-base font-medium', style.text)}>{meta.label}</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-label',
                  meta.risk === 'low' && 'bg-elev-2 text-fg-muted',
                  meta.risk === 'medium' && 'bg-yellow-500/10 text-yellow-400',
                  meta.risk === 'high' && 'bg-orange-500/10 text-orange-400',
                  meta.risk === 'critical' && 'bg-red-500/10 text-red-400',
                )}
              >
                {meta.risk}
              </span>
            </div>
            <p className='mt-2 text-sm text-fg-muted'>{meta.description}</p>
          </div>

          {/* extra warning for critical */}
          {meta.risk === 'critical' && (
            <div className='rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-xs text-red-400'>
              are you absolutely sure? this site can sign transactions on your behalf without
              confirmation.
            </div>
          )}
        </div>
      </div>
    </ApprovalScreen>
  );
};
