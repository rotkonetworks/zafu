/**
 * The ask-at-the-moment sheet: the UI side of {@link setEgressAsker}. Several
 * destinations a feature needs together are asked in one sheet, one tap.
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
  views: DestinationView[];
  resolve: (allowed: boolean) => void;
}

export const EgressAskSheet = () => {
  const [pending, setPending] = useState<PendingAsk>();

  useEffect(() => {
    const ask: EgressAsker = views => new Promise(resolve => setPending({ views, resolve }));
    return setEgressAsker(ask);
  }, []);

  const respond = (allowed: boolean): void => {
    pending?.resolve(allowed);
    setPending(undefined);
  };

  const views = pending?.views ?? [];
  const hostOf = (v: DestinationView) => v.hosts[0] ?? v.label;
  // the people relay has its own words (design-social 5.0)
  const people = views.length === 1 && views[0]!.id === 'people-relay';
  const one = views.length === 1;

  return (
    <Sheet
      open={!!pending}
      onOpenChange={open => {
        if (!open) {
          respond(false);
        }
      }}
      title={
        people
          ? 'use a relay for messages?'
          : one
            ? 'allow this connection'
            : 'allow these connections'
      }
    >
      {pending && (
        <div className='flex flex-col gap-4 px-1 text-sm text-fg-muted lowercase'>
          {people ? (
            <p>
              messages go through{' '}
              <span className='font-mono text-fg-high'>{hostOf(views[0]!).split('/')[0]}</span>. it
              sees when you check in, never what you say.
            </p>
          ) : one ? (
            <>
              <p>
                {views[0]!.label} needs to talk to{' '}
                <span className='font-mono text-fg-high'>{hostOf(views[0]!)}</span> - zafu hasn't
                contacted it before.
              </p>
              <p className='text-xs text-fg-dim'>{NET_PURPOSE_LABEL[views[0]!.purpose]}</p>
            </>
          ) : (
            <>
              <p>zafu hasn't contacted these before, and asks them only while you use this.</p>
              <ul className='flex flex-col gap-1.5'>
                {views.map(v => (
                  <li key={v.id} className='flex justify-between gap-3 text-xs'>
                    <span>{v.label}</span>
                    <span className='truncate font-mono text-fg-high'>{hostOf(v)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
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
