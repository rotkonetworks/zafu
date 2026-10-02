/**
 * Private-contact-discovery consent popup.
 *
 * Opened by external apps via `zafu_request_contact_discovery`: the app asked
 * the USER to show it which friends are here (ReqDiscover.dc.html). The
 * answer is for THIS site only, and it says the one cost straight: friends
 * here will see you are online. The relay it uses is the wallet's own (the
 * app cannot choose it), listed under "everything zafu talks to".
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
  // the site's own host, never its page title: a title is whatever the page says
  const host = origin ? hostnameOf(origin) : 'this site';

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
              <span className='truncate text-sm text-fg-high'>{host}</span>
              {origin && (
                <span className='truncate text-xs text-fg-muted'>
                  <SafeOriginURL origin={origin} /> · find friends
                </span>
              )}
            </div>
          </div>
          <Mark variant='seal' size={40} />
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            show {host} which friends are here?
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
          <p>only friends who also use {host}</p>
          <p>never your whole contact list</p>
          <p>the relay can&apos;t tell who you looked for</p>
          <p>friends here will see you are online</p>
        </div>
      </div>
    </ApprovalScreen>
  );
};
