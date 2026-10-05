/**
 * "use this relay?": a relay zafu does not know is named, by its host, and
 * needs its own yes before anything is written or joined - even when people
 * already talks to its own relay. One sheet for invites and for cards.
 */

import { useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { relayHost } from '../config/people-relay';
import { allowRelay } from './use-invites';

/** `ask(relay)` resolves true once the person said yes and the relay is allowed */
export const useRelayAsk = () => {
  const [asking, setAsking] = useState<{ relay: string; resolve: (ok: boolean) => void }>();
  const ask = (relay: string) => new Promise<boolean>(resolve => setAsking({ relay, resolve }));
  const answer = (ok: boolean) => {
    const a = asking;
    setAsking(undefined);
    if (!a) {
      return;
    }
    void (ok ? allowRelay(a.relay) : Promise.resolve(false)).then(a.resolve, () =>
      a.resolve(false),
    );
  };
  const sheet = (
    <Sheet open={!!asking} onOpenChange={o => !o && answer(false)} title='use this relay?'>
      <div className='flex flex-col gap-4 px-1 text-sm text-fg-muted'>
        <p>
          <span className='font-mono text-fg-high'>{asking && relayHost(asking.relay)}</span> is a
          relay zafu does not know. it would see when you check in, never what you say.
        </p>
        <div className='flex gap-2'>
          <Button variant='secondary' className='flex-1' onClick={() => answer(false)}>
            not now
          </Button>
          <Button className='flex-1' onClick={() => answer(true)}>
            allow
          </Button>
        </div>
      </div>
    </Sheet>
  );
  return { ask, sheet };
};
