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
import { LinkGradientIcon } from '../../../icons/link-gradient';

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
        <header className='flex h-[70px] flex-col items-center justify-center border-b border-border-soft'>
          <span className='kicker mb-1'>passkey request</span>
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>create a passkey</h1>
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
          <div className='flex items-center gap-2 bg-canvas p-3'>
            {origin && (
              <span className='text-xs text-fg-muted truncate'>
                <SafeOriginURL origin={origin} />
              </span>
            )}
          </div>

          {/* what is being granted */}
          <div className='border border-orange-500/40 bg-orange-500/10 p-4'>
            <div className='text-base font-medium text-orange-400'>sign in as you</div>
            <p className='mt-2 text-sm text-fg-muted'>
              this site is asking zafu to create a passkey for it. if you approve, a site-bound
              credential derived from your wallet seed is created and stored in the wallet. the site
              can then ask you to approve sign-ins with it.
            </p>
            <p className='mt-2 text-sm text-fg-muted'>
              the passkey never leaves the wallet; only a public key and signatures are shared.
              approving also lets this site sign you in with the passkey without asking again - you
              can revoke it in connected sites. deny to keep this site from registering a
              credential.
            </p>
          </div>
        </div>
      </div>
    </ApprovalScreen>
  );
};
