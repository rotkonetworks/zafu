/**
 * The ask-at-the-moment sheet: the UI side of {@link setEgressAsker}.
 *
 * Mounted once at the root of each realm that has one (popup, page). While
 * installed, a feature calling {@link requestEgressOptIn} for an off
 * destination raises this sheet instead of failing; "allow" persists the
 * choice (`requestEgressOptIn` itself calls `setDestinationOptIn`), "not now"
 * declines without recording a block, so the question can be asked again
 * later.
 *
 * The service worker has its own consent window (`./prompt`) for a host no
 * destination owns; this sheet is for the popup/page realms, where opening a
 * whole new window over a feature the user is already looking at would be
 * noise.
 */

import { useEffect, useState } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { setEgressAsker, type EgressAsker } from './egress-opt-in';
import { NET_PURPOSE_LABEL } from './purpose';
import type { DestinationView } from './egress-policy';

interface PendingAsk {
  view: DestinationView;
  resolve: (allowed: boolean) => void;
}

export const EgressAskSheet = () => {
  const [pending, setPending] = useState<PendingAsk>();

  useEffect(() => {
    const ask: EgressAsker = view => new Promise(resolve => setPending({ view, resolve }));
    return setEgressAsker(ask);
  }, []);

  const respond = (allowed: boolean): void => {
    pending?.resolve(allowed);
    setPending(undefined);
  };

  const host = pending?.view.hosts[0] ?? pending?.view.label;

  return (
    <Sheet
      open={!!pending}
      onOpenChange={open => {
        if (!open) {
          respond(false);
        }
      }}
      title='allow this connection'
    >
      {pending && (
        <div className='flex flex-col gap-4 px-1 text-sm text-fg-muted lowercase'>
          <p>
            {pending.view.label} needs to talk to{' '}
            <span className='font-mono text-fg-high'>{host}</span> - zafu hasn't contacted it
            before.
          </p>
          <p className='text-xs text-fg-dim'>{NET_PURPOSE_LABEL[pending.view.purpose]}</p>
          <div className='flex gap-2 pt-1'>
            <Button variant='secondary' size='md' className='flex-1' onClick={() => respond(false)}>
              not now
            </Button>
            <Button variant='primary' size='md' className='flex-1' onClick={() => respond(true)}>
              allow
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
};
