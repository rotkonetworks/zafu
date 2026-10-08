/**
 * A broadcast that could not reach nym waits here (see `viaNym`): send it
 * directly this once, or not at all. Mounted beside {@link EgressAskSheet} in
 * every window, so any send path (send, swap, liquidity, an approval) is
 * asked the same way; the first window to answer closes it in the others.
 * The answer never touches the "send over nym" setting.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { Button } from '@repo/ui/components/ui/button';
import { onNymMessage, postNym } from './nym-bridge';

let rerouteAt = 0;
const onReroute = (changed: () => void) =>
  onNymMessage(m => {
    if (m.type === 'reroute') {
      rerouteAt = Date.now();
      changed();
    }
  });

/** when nym last dropped a route that did not answer, as this window heard it */
export const useNymRerouteAt = (): number => useSyncExternalStore(onReroute, () => rerouteAt);

export const NymHeldSheet = () => {
  const [held, setHeld] = useState<{ id: string; host: string; sent: boolean }>();

  useEffect(
    () =>
      onNymMessage(m => {
        if (m.type === 'held') {
          setHeld({ id: m.id, host: m.host, sent: m.sent });
        } else if (m.type === 'answer') {
          setHeld(h => (h?.id === m.id ? undefined : h));
        }
      }),
    [],
  );

  const answer = (direct: boolean): void => {
    if (held) {
      postNym({ type: 'answer', id: held.id, direct });
      setHeld(undefined);
    }
  };

  return (
    <Sheet
      open={!!held}
      onOpenChange={open => !open && answer(false)}
      title={held?.sent ? "nym didn't answer in time" : "nym isn't reachable right now"}
    >
      {held && (
        <div className='flex flex-col gap-4 px-1 text-sm text-fg-muted lowercase'>
          <p>
            {held.sent
              ? 'it may have arrived already. sending it again is safe, the network keeps one copy.'
              : 'nothing was sent.'}
          </p>
          <p className='text-xs text-fg-dim'>
            directly, <span className='font-mono'>{held.host}</span> sees where it comes from. only
            this send.
          </p>
          <div className='flex gap-2 pt-1'>
            <Button variant='secondary' size='md' className='flex-1' onClick={() => answer(false)}>
              don't send
            </Button>
            <Button variant='primary' size='md' className='flex-1' onClick={() => answer(true)}>
              send directly instead
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
};
