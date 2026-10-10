/**
 * An app asks to connect you with one of its people (zafu_connect): two
 * players at a table. Yes keeps a private room with them, made once they say
 * yes too; no tells the app nothing. The app can send them an invite from you
 * later, into that room.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApprovalScreen } from './approval-screen';
import { ApproveDeny } from './approve-deny';
import { OriginIcon, hostnameOf } from '../../../shared/components/origin-icon';
import { Mark } from '@repo/ui/components/ui/mark';
import { Clipped } from '@repo/ui/components/ui/clipped';
import { StatusSlot } from '@repo/ui/components/ui/status-slot';
import { useStartConnect } from '../../../people/connect-page';

export const ConnectApproval = () => {
  const [params] = useSearchParams();
  const origin = params.get('app') || '';
  const requestId = params.get('requestId') || '';
  const name = params.get('name') || '';
  const peer = {
    pubkey: params.get('pubkey') || '',
    ka: params.get('ka') || '',
    ka_sig: params.get('ka_sig') || '',
  };
  const host = origin ? hostnameOf(origin) : 'this site';
  const who = name || 'them';
  const start = useStartConnect();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  const done = async () => {
    // await before closing: window.close() can drop the send (see passkey.tsx)
    try {
      await chrome.runtime.sendMessage({ type: 'zafu_connect_result', requestId });
    } catch {
      // the service worker went away: closing is all that is left
    }
    window.close();
  };

  const connect = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await start(origin, peer, name);
      await done();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'something broke on our side, not yours');
      setBusy(false);
    }
  };

  return (
    <ApprovalScreen
      header={
        <header className='flex flex-col items-center justify-center gap-2 border-b border-border-soft px-4 py-4'>
          <div className='flex w-full items-center gap-2'>
            {!!origin && <OriginIcon origin={origin} size={32} />}
            <Clipped className='text-sm text-fg-high' label='site'>
              {host}
            </Clipped>
          </div>
          <Mark variant='seal' size={40} />
          <h1 className='text-title text-fg-high lowercase tracking-[-0.01em]'>
            <Clipped label='name'>connect with {who}?</Clipped>
          </h1>
        </header>
      }
      footer={
        <ApproveDeny
          approve={() => void connect()}
          deny={() => void done()}
          approveLabel={busy ? 'connecting' : 'connect'}
          denyLabel='not now'
        />
      }
    >
      <div className='flex w-full flex-col gap-2 px-[30px] text-xs text-fg-muted'>
        <p>a private room in people, once {who} says yes too</p>
        <p>no payment, nothing on chain</p>
        <p>{host} learns nothing unless you both say yes</p>
        <p>{host} may hand them an invite from you</p>
        {failed && (
          <StatusSlot tone='danger' icon='i-ph-warning-circle'>
            {failed}
          </StatusSlot>
        )}
      </div>
    </ApprovalScreen>
  );
};
