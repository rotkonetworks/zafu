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
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { Mark } from '@repo/ui/components/ui/mark';
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
  const appName = title || (origin ? hostnameOf(origin) : 'this app');

  const respond = async (approved: boolean) => {
    // Await before closing (see passkey.tsx): window.close() tears this popup
    // down synchronously and can race the send, dropping it unanswered.
    try {
      await chrome.runtime.sendMessage({
        type: 'zafu_contact_discovery_approval_result',
        requestId,
        result: { approved },
      });
    } catch {
      // service worker unreachable or reloaded - closing is all we can do
    }
    window.close();
  };

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-2 border-b border-border-soft px-4 py-4'>
          <div className='flex w-full items-center gap-2'>
            {!!origin && <OriginIcon origin={origin} size={32} />}
            <div className='flex min-w-0 flex-col'>
              {title && <span className='truncate text-sm text-fg-high'>{title}</span>}
              {origin && (
                <span className='truncate text-xs text-fg-muted'>
                  <SafeOriginURL origin={origin} />
                </span>
              )}
            </div>
          </div>
          <Mark variant='seal' size={40} />
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            show {appName} which friends are here?
          </h1>
        </header>
      }
      footer={
        <ApproveDeny
          approve={() => respond(true)}
          deny={() => respond(false)}
          approveLabel='show friends'
        />
      }
    >
      <div className='w-full px-[30px]'>
        <div className='flex flex-col gap-2 text-xs text-fg-muted'>
          <p>only friends who also use {appName}</p>
          <p>never your whole contact list</p>
          <p>the relay can&apos;t tell who you looked for</p>
          <p>friends here will see you are online</p>
          <p className='break-all font-mono text-fg-dim'>relay {relay}</p>
        </div>
      </div>
    </ApprovalScreen>
  );
};
