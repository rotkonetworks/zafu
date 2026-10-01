/**
 * Private-contact-discovery consent popup.
 *
 * Opened by external apps via `zafu_request_contact_discovery`: the app asked
 * the USER to turn private contact discovery on. This popup is the user's
 * decision, and it must be an INFORMED one - so it states plainly that
 * accepting turns the feature on for EVERY app, not just the caller, and it
 * shows the relay the wallet will actually use (the app cannot choose it).
 *
 * On approve/deny it reports the decision to the service worker over the
 * internal callback `zafu_contact_discovery_approval_result`; closing the
 * window without deciding is handled worker-side as a cancellation.
 */

import { useSearchParams } from 'react-router-dom';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { OriginIcon } from '../../../shared/components/origin-icon';
import { LinkGradientIcon } from '../../../icons/link-gradient';
import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../../../config/contact-discovery-relay';

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

export const ContactDiscoveryApproval = () => {
  const [params] = useSearchParams();
  const origin = params.get('app') || '';
  const requestId = params.get('requestId') || '';
  const title = params.get('title') || '';
  // The endpoint the wallet will ACTUALLY use (the worker resolved a configured
  // endpoint, else the built-in default). Falling back to the constant keeps the
  // popup honest if the param is ever missing - never show a relay we're not sure of.
  const relay = params.get('relay') || DEFAULT_CONTACT_DISCOVERY_RELAY;

  const respond = (approved: boolean) => {
    void chrome.runtime.sendMessage({
      type: 'zafu_contact_discovery_approval_result',
      requestId,
      result: { approved },
    });
    window.close();
  };

  return (
    <ApprovalScreen
      header={
        <header className='flex h-[70px] flex-col items-center justify-center border-b border-border-soft'>
          <span className='kicker mb-1'>app request</span>
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            private contact discovery
          </h1>
        </header>
      }
      footer={<ApproveDeny approve={() => respond(true)} deny={() => respond(false)} />}
    >
      <div className='mx-auto size-20'>
        <LinkGradientIcon />
      </div>
      <div className='w-full px-[30px]'>
        <div className='flex flex-col gap-3'>
          {/* requesting app */}
          <div className='flex items-center gap-2 bg-canvas p-3'>
            {!!origin && <OriginIcon origin={origin} size={32} />}
            <div className='flex flex-col overflow-hidden'>
              {title && <span className='text-sm truncate'>{title}</span>}
              {origin && (
                <span className='text-xs text-fg-muted truncate'>
                  <SafeOriginURL origin={origin} />
                </span>
              )}
            </div>
          </div>

          {/* what it means */}
          <p className='text-sm text-fg-muted'>
            an app learns only which contacts are present in that app, under app-scoped handles -
            never your contact list, and unlinkable across apps.
          </p>

          {/* the wallet-wide consequence, stated plainly */}
          <div className='border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-400'>
            turns on private contact discovery for every app, not just this one.
          </div>

          {/* the relay the wallet will use - the app cannot choose it */}
          <div className='border border-border-soft bg-canvas p-3'>
            <p className='kicker mb-1'>relay</p>
            <p className='break-all font-mono text-xs text-fg-high'>{relay}</p>
            <p className='mt-1 text-xs text-fg-muted'>
              your wallet chooses the relay; the app cannot point it elsewhere.
            </p>
          </div>
        </div>
      </div>
    </ApprovalScreen>
  );
};
