/**
 * Outbound-destination (net egress) consent popup.
 *
 * Raised by the egress gate when a request would connect to a host that is not
 * in zafu's config for an enabled network. The HOST is the decision: this popup
 * states plainly that approving makes that host an allowed network destination
 * for the wallet, and shows which site asked when the gate knows it.
 *
 * On approve/deny it reports the decision to the service worker over the
 * internal callback (NET_EGRESS_INTERNAL_METHODS[0]); closing the window without
 * deciding is handled worker-side as a cancellation.
 */

import { useSearchParams } from 'react-router-dom';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { NET_EGRESS_INTERNAL_METHODS } from '../../../message/listen/zafu-method-names';

// `new URL()` throws on a malformed string; the `app` query param is only
// truthiness-checked upstream, so parse defensively and fall back to the raw text.
const SafeOriginURL = ({ origin }: { origin: string }) => {
  let url: URL | undefined;
  try {
    url = new URL(origin);
  } catch {
    url = undefined;
  }
  return url ? <DisplayOriginURL url={url} /> : <span className='break-all'>{origin}</span>;
};

export const DestinationApproval = () => {
  const [params] = useSearchParams();
  const host = params.get('host') || '';
  const purposeLabel = params.get('purposeLabel') || '';
  const requestId = params.get('requestId') || '';
  const origin = params.get('app') || '';
  const detail = params.get('detail') || '';

  const respond = (approved: boolean) => {
    // A missing requestId means the worker cannot match the answer; never send
    // it. Closing the window is treated worker-side as a cancellation.
    if (requestId) {
      void chrome.runtime.sendMessage({
        type: NET_EGRESS_INTERNAL_METHODS[0],
        requestId,
        result: { approved },
      });
    }
    window.close();
  };

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-1 border-b border-border-soft px-6 py-4'>
          <span className='kicker'>network request</span>
          <h1 className='text-title break-all text-center font-mono text-fg-high tracking-[-0.01em]'>
            {host}
          </h1>
        </header>
      }
      footer={
        requestId ? (
          <ApproveDeny approve={() => respond(true)} deny={() => respond(false)} />
        ) : (
          <ApproveDeny approve={() => window.close()} deny={() => window.close()} />
        )
      }
    >
      <div className='w-full px-[30px]'>
        <div className='flex flex-col gap-3'>
          {/* what is being decided, in the user's terms */}
          <p className='text-sm text-fg-muted'>
            allow this host as a network destination for your wallet? requests to it would be
            permitted from now on.
          </p>

          {/* why - a human label for the purpose the wallet assigned */}
          {purposeLabel && (
            <div className='rounded-lg border border-border-soft bg-canvas p-3'>
              <p className='kicker mb-1'>purpose</p>
              <p className='text-xs text-fg-high'>{purposeLabel}</p>
            </div>
          )}

          {/* which site asked */}
          {origin && (
            <div className='rounded-lg border border-border-soft bg-canvas p-3'>
              <p className='kicker mb-1'>requested by</p>
              <p className='truncate text-xs text-fg-muted'>
                <SafeOriginURL origin={origin} />
              </p>
            </div>
          )}

          {/* one line zafu wrote, never a URL */}
          {detail && <p className='text-xs text-fg-muted'>{detail}</p>}
        </div>
      </div>
    </ApprovalScreen>
  );
};
