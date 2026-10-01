/**
 * passkey-approve - per-credential consent for external dapp passkey creation.
 *
 * opened by zafu_passkey_create. The bus never mints here: this popup only
 * reports approve/deny via zafu_passkey_create_result, and the service worker
 * mints the site-bound P-256 credential (it is the only context with mnemonic
 * access). No seed material ever reaches this window.
 */

import { useSearchParams } from 'react-router-dom';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { Mark } from '@repo/ui/components/ui/mark';

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

export const PasskeyApprove = () => {
  const [params] = useSearchParams();
  const origin = params.get('app') || '';
  const requestId = params.get('requestId') || '';

  const respond = async (approved: boolean) => {
    // Deliver the decision BEFORE closing: `window.close()` removes the window
    // synchronously, and the service worker's onRemoved sweep would then race
    // the message - an approve that lost the race arrived as "cancelled", so
    // the site fell back to the platform authenticator and no credential was
    // ever minted. Awaiting makes the decision land while the window still
    // exists; the popup then closes as cancellable as before.
    try {
      await chrome.runtime.sendMessage({
        type: 'zafu_passkey_create_result',
        requestId,
        result: { approved },
      });
    } catch {
      // the service worker is unreachable or was reloaded: closing is the only
      // way to release the window (the request is already lost either way).
    }
    window.close();
  };

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-2 border-b border-border-soft px-4 py-4'>
          {origin && (
            <div className='flex w-full items-center gap-2'>
              <OriginIcon origin={origin} size={32} />
              <span className='truncate text-xs text-fg-muted'>
                <SafeOriginURL origin={origin} />
              </span>
            </div>
          )}
          <Mark variant='seal' size={40} />
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            create a passkey for {origin ? hostnameOf(origin) : 'this site'}
          </h1>
        </header>
      }
      footer={
        <ApproveDeny
          approve={() => respond(true)}
          deny={() => respond(false)}
          approveLabel='create passkey'
          denyLabel='not now'
        />
      }
    >
      <div className='w-full px-[30px]'>
        <p className='text-xs text-fg-muted'>
          the key stays in zafu and comes back with your recovery phrase.
        </p>
      </div>
    </ApprovalScreen>
  );
};
