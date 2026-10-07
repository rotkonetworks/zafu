/**
 * passkey-approve - the one tap every passkey request takes: creating one
 * (zafu_passkey_create) and every sign-in (zafu_passkey_get). This window only
 * reports the tap via zafu_passkey_result; the service worker mints or signs
 * with its own copy of the request. No seed material ever reaches it.
 */

import { useSearchParams } from 'react-router-dom';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { DisplayOriginURL } from '../../../shared/components/display-origin-url';
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { Mark } from '@repo/ui/components/ui/mark';
import { RowGroup } from '@repo/ui/components/ui/row';
import { useStore } from '../../../state';

const COPY = {
  create: {
    title: (site: string) => `create a passkey for ${site}`,
    approve: 'create passkey',
    note: 'the key stays in zafu and comes back with your recovery phrase.',
  },
  get: {
    title: (site: string) => `sign in to ${site}?`,
    approve: 'sign in',
    note: undefined,
  },
} as const;

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
  // the domain the passkey signs in to; a site may name a parent of its own host
  const rpId = params.get('rp') || '';
  const copy = COPY[params.get('mode') === 'get' ? 'get' : 'create'];
  const walletId = params.get('wallet');
  const keyInfo = useStore(s => s.keyRing.keyInfos.find(k => k.id === walletId));

  const respond = async (approved: boolean) => {
    // Deliver the decision BEFORE closing: `window.close()` removes the window
    // synchronously, and the service worker's onRemoved sweep would then race
    // the message - an approve that lost the race arrived as "cancelled", so
    // the site fell back to the platform authenticator and no credential was
    // ever minted. Awaiting makes the decision land while the window still
    // exists; the popup then closes as cancellable as before.
    try {
      await chrome.runtime.sendMessage({
        type: 'zafu_passkey_result',
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
            {copy.title(origin ? hostnameOf(origin) : 'this site')}
          </h1>
        </header>
      }
      footer={
        <ApproveDeny
          approve={() => respond(true)}
          deny={() => respond(false)}
          approveLabel={copy.approve}
          denyLabel='not now'
        />
      }
    >
      <div className='flex w-full flex-col gap-3 px-[30px]'>
        <RowGroup>
          {rpId && (
            <div className='flex h-12 items-center justify-between gap-3 px-3.5 text-sm'>
              <span className='text-fg-muted'>signs in to</span>
              <span className='truncate text-fg-high'>{rpId}</span>
            </div>
          )}
          {keyInfo && (
            <div className='flex h-12 items-center justify-between px-3.5 text-sm'>
              <span className='text-fg-muted'>account</span>
              <span className='text-fg-high'>{keyInfo.name}</span>
            </div>
          )}
        </RowGroup>
        {copy.note && <p className='text-xs text-fg-muted'>{copy.note}</p>}
      </div>
    </ApprovalScreen>
  );
};
