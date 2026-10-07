import { useSearchParams } from 'react-router-dom';
import {
  CAPABILITY_META,
  TIME_LIMITED_CAPABILITIES,
  type Capability,
  type RiskLevel,
} from '@repo/storage-chrome/capabilities';
import { cn } from '@repo/ui/lib/utils';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { Mark } from '@repo/ui/components/ui/mark';
import { Clipped } from '@repo/ui/components/ui/clipped';

const riskStyles: Record<RiskLevel, { border: string; bg: string; text: string }> = {
  low: { border: 'border-border-soft', bg: '', text: 'text-fg-muted' },
  medium: { border: 'border-yellow-500/30', bg: 'bg-yellow-500/5', text: 'text-yellow-400' },
  high: { border: 'border-orange-500/40', bg: 'bg-orange-500/5', text: 'text-orange-400' },
  critical: { border: 'border-red-500/50', bg: 'bg-red-500/10', text: 'text-red-400' },
};

// the one-line consequence of approving, said plainly, in the site's terms:
// [button label, hero-line lead-in before the host].
const APPROVE_COPY: Partial<Record<Capability, [string, string]>> = {
  encrypt: ['open it', 'open a message sent to you on'],
  passkey: ['sign in', 'sign in to'],
};
const DEFAULT_APPROVE_COPY: [string, string] = ['allow', 'allow'];

// `new URL()` throws on a malformed string; the `app` query param is only
// truthiness-checked, so parse defensively and fall back to the raw text.
const SafeOriginURL = ({ origin }: { origin: string }) => {
  let url: URL | undefined;
  try {
    url = new URL(origin);
  } catch {
    url = undefined;
  }
  return url ? <DisplayOriginURL url={url} /> : <span className='break-all'>{origin}</span>;
};

export const CapabilityApproval = () => {
  const [params] = useSearchParams();
  const origin = params.get('app') || '';
  const capability = params.get('capability') as Capability | null;
  const requestId = params.get('requestId') || '';
  const title = params.get('title') || '';
  // Scope 'zafu' is the one-time global opt-in: the question is whether zafu
  // should offer this capability at all, so it is asked with no site attached
  // and every later site still gets its own per-origin consent.
  const scope = params.get('scope') === 'zafu' ? 'zafu' : 'site';

  if (!capability || !(capability in CAPABILITY_META)) {
    return <div className='p-4 text-red-400'>zafu couldn't read this request</div>;
  }

  const meta = CAPABILITY_META[capability];
  const style = riskStyles[meta.risk];

  const respond = async (approved: boolean) => {
    // Await before closing (see passkey.tsx): window.close() tears this popup
    // down synchronously and can race the send, dropping it unanswered.
    try {
      await chrome.runtime.sendMessage({
        type: 'zafu_capability_result',
        requestId,
        result: { approved },
      });
    } catch {
      // service worker unreachable or reloaded - closing is all we can do
    }
    window.close();
  };

  const [verb, lead] = APPROVE_COPY[capability] ?? DEFAULT_APPROVE_COPY;
  const remembers = scope === 'site' && TIME_LIMITED_CAPABILITIES.has(capability);
  const host = origin ? hostnameOf(origin) : 'this site';

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-2 border-b border-border-soft px-4 py-4'>
          {scope === 'site' && (
            <div className='flex w-full items-center gap-2'>
              {!!origin && <OriginIcon origin={origin} size={32} />}
              <div className='flex min-w-0 flex-col'>
                {title && <Clipped className='text-sm text-fg-high'>{title}</Clipped>}
                {origin && (
                  <Clipped className='text-xs text-fg-muted' label='site'>
                    <SafeOriginURL origin={origin} />
                  </Clipped>
                )}
              </div>
            </div>
          )}
          <Mark variant='seal' size={40} />
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            {scope === 'zafu' ? `enable ${meta.label.toLowerCase()}?` : `${lead} ${host}`}
          </h1>
        </header>
      }
      footer={
        <ApproveDeny
          approve={() => respond(true)}
          deny={() => respond(false)}
          approveLabel={verb}
        />
      }
    >
      <div className='w-full px-[30px]'>
        <div className='flex flex-col gap-2'>
          <div
            className={cn(
              'flex items-center justify-between gap-2 border p-3',
              style.border,
              style.bg,
            )}
          >
            <span className={cn('text-sm lowercase', style.text)}>{meta.label}</span>
            {meta.risk !== 'low' && (
              <span
                className={cn(
                  'shrink-0 px-1.5 py-0.5 text-label',
                  meta.risk === 'medium' && 'bg-yellow-500/10 text-yellow-400',
                  meta.risk === 'high' && 'bg-orange-500/10 text-orange-400',
                  meta.risk === 'critical' && 'bg-red-500/10 text-red-400',
                )}
              >
                {meta.risk}
              </span>
            )}
          </div>

          {remembers && (
            <p className='text-xs text-fg-muted'>good for 30 days, then {host} asks again.</p>
          )}

          {meta.risk === 'critical' && (
            <div className='border border-red-500/50 bg-red-500/10 p-3 text-xs text-red-400'>
              {scope === 'zafu'
                ? 'a site you approve can then sign without asking each time.'
                : 'this site can sign on your behalf without asking each time.'}
            </div>
          )}
        </div>
      </div>
    </ApprovalScreen>
  );
};
