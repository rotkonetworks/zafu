import { useStore } from '../../../state';
import { originApprovalSelector } from '../../../state/origin-approval';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { Mark } from '@repo/ui/components/ui/mark';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { OriginIcon } from '../../../shared/components/origin-icon';
import { cn } from '@repo/ui/lib/utils';
import { UserChoice } from '@repo/storage-chrome/records';
import { exitApprovalSurface, usePopupNav } from '../../../utils/navigate';
import {
  CAPABILITY_META,
  type Capability,
  type RiskLevel,
} from '@repo/storage-chrome/capabilities';
import { useApprovalFixture } from './use-approval-fixture';

const riskStyles: Record<RiskLevel, { border: string; bg: string; text: string }> = {
  low: { border: 'border-border-soft', bg: '', text: 'text-fg-muted' },
  medium: { border: 'border-yellow-500/30', bg: 'bg-yellow-500/5', text: 'text-yellow-400' },
  high: { border: 'border-orange-500/40', bg: 'bg-orange-500/5', text: 'text-orange-400' },
  critical: { border: 'border-red-500/50', bg: 'bg-red-500/10', text: 'text-red-400' },
};

const CapabilityItem = ({ cap }: { cap: Capability }) => {
  const meta = CAPABILITY_META[cap];
  // Defensive: an unknown/renamed capability string (dapp-controlled input, or
  // a cap removed between versions) has no meta - render nothing rather than
  // dereferencing undefined.risk and crashing the whole connect prompt.
  if (!meta) {
    return null;
  }
  const style = riskStyles[meta.risk];

  return (
    <div className={cn('border p-3', style.border, style.bg)}>
      <div className='flex items-center justify-between gap-2'>
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
      <p className='mt-0.5 text-xs lowercase text-fg-muted'>{meta.description}</p>
    </div>
  );
};

export const OriginApproval = () => {
  const navigate = usePopupNav();
  const { requestOrigin, title, lastRequest, requestedCapabilities, setChoice, sendResponse } =
    useStore(originApprovalSelector);
  const acceptRequest = useStore(s => s.originApproval.acceptRequest);

  useApprovalFixture(!!requestOrigin, () => {
    void acceptRequest({
      origin: 'https://zk.poker',
      title: 'zk.poker',
      capabilities: ['connect', 'sign_identity', 'send_tx', 'frost'],
    } as Parameters<typeof acceptRequest>[0]);
  });

  const approve = () => {
    setChoice(UserChoice.Approved);
    sendResponse();
    exitApprovalSurface(navigate);
  };

  const deny = () => {
    setChoice(UserChoice.Denied);
    sendResponse();
    exitApprovalSurface(navigate);
  };

  const ignore = () => {
    setChoice(UserChoice.Ignored);
    sendResponse();
    exitApprovalSurface(navigate);
  };

  if (!requestOrigin) {
    return null;
  }

  // Only render/score capabilities we actually know. requestedCapabilities is
  // dapp-controlled (state/origin-approval.ts only checks Array.isArray), so an
  // unknown or renamed cap string would otherwise crash the reduce/map below.
  const knownCapabilities = requestedCapabilities.filter(cap => cap in CAPABILITY_META);

  // determine highest risk level for banner
  const maxRisk = knownCapabilities.reduce<RiskLevel>((max, cap) => {
    const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
    const capRisk = CAPABILITY_META[cap].risk;
    return levels.indexOf(capRisk) > levels.indexOf(max) ? capRisk : max;
  }, 'low');

  // A malformed sender origin should not white-screen the prompt either.
  let originUrl: URL | undefined;
  try {
    originUrl = new URL(requestOrigin);
  } catch {
    originUrl = undefined;
  }

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-2 border-b border-border-soft px-4 py-4'>
          <div className='flex w-full items-center gap-2'>
            {!!requestOrigin && <OriginIcon origin={requestOrigin} size={32} />}
            <div className='flex min-w-0 flex-col'>
              <span className='truncate text-sm text-fg-high'>{title || 'this site'}</span>
              <span className='truncate text-xs text-fg-muted'>
                {originUrl ? (
                  <DisplayOriginURL url={originUrl} />
                ) : (
                  <span className='break-all'>{requestOrigin}</span>
                )}
              </span>
            </div>
          </div>
          <Mark variant='seal' size={40} />
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            connect {originUrl?.hostname ?? requestOrigin}
          </h1>
        </header>
      }
      footer={
        <ApproveDeny
          approve={approve}
          deny={deny}
          ignore={lastRequest && ignore}
          approveLabel='connect'
        />
      }
    >
      <div className='w-full px-[30px]'>
        <div className='flex flex-col gap-2'>
          {/* capability list, one line each */}
          <div className='flex flex-col gap-2'>
            {knownCapabilities.map(cap => (
              <CapabilityItem key={cap} cap={cap} />
            ))}
          </div>

          {/* extra warning for high/critical */}
          {(maxRisk === 'high' || maxRisk === 'critical') && (
            <div
              className={cn(
                'border p-3 text-xs',
                maxRisk === 'critical'
                  ? 'border-red-500/50 bg-red-500/10 text-red-400'
                  : 'border-orange-500/40 bg-orange-500/5 text-orange-400',
              )}
            >
              {maxRisk === 'critical'
                ? 'this includes dangerous capabilities.'
                : 'review these permissions carefully.'}
            </div>
          )}

          <p className='text-xs text-fg-muted'>never: your recovery phrase.</p>
        </div>
      </div>
    </ApprovalScreen>
  );
};
