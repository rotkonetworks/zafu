/**
 * Invites that came in a memo, pinned on the people tab (the canvas
 * Request / needs-you row): who wants to chat, and on which relay. "no,
 * thank you" and ignoring both leave every relay alone. A relay zafu does not
 * know is named as such and needs its own allow before anything is joined.
 */

import { useEffect, useState } from 'react';
import { Button } from '@repo/ui/components/ui/button';
import { DEFAULT_PEOPLE_RELAY, relayHost } from '../config/people-relay';
import { useMyInvites } from './client';
import { knownRelay, useAnswerInvite } from './use-invites';
import { useRelayAsk } from './relay-ask';
import type { StoredInvite } from './vault';

const lineOf = (inv: StoredInvite, relay: string): string => {
  if (!inv.read.ok) {
    return 'an invite this zafu cannot read yet';
  }
  const i = inv.read.invite;
  const on = relayHost(relay);
  return i.kind === 'pair'
    ? `${i.name || 'someone'} wants to chat · on ${on}`
    : `${i.from || 'someone'} invites you to ${i.group} · on ${on}`;
};

const InviteRow = ({
  inv,
  onAllow,
}: {
  inv: StoredInvite;
  onAllow: (relay: string) => Promise<boolean>;
}) => {
  const { accept, decline } = useAnswerInvite();
  const [busy, setBusy] = useState(false);
  const relay = (inv.read.ok && inv.read.invite.relay) || '';
  const shown = relay || DEFAULT_PEOPLE_RELAY;
  const [known, setKnown] = useState<boolean>();
  useEffect(() => {
    void knownRelay(relay).then(setKnown, () => setKnown(false));
  }, [relay]);
  const go = async () => {
    setBusy(true);
    try {
      if (!known && !(await onAllow(relay))) {
        return;
      }
      await accept(inv);
    } catch {
      // the row stays; nothing was joined
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className='flex flex-col gap-2.5 border border-border-hard bg-elev-1 p-3.5'>
      <span className='flex items-start gap-3'>
        <span
          className='i-lucide-mail-plus mt-0.5 size-4 shrink-0 text-zigner-gold'
          aria-hidden='true'
        />
        <span className='flex min-w-0 flex-col gap-[3px]'>
          <span className='text-[13px] text-fg-high'>{lineOf(inv, shown)}</span>
          {known === false && (
            <span className='text-[11px] text-warn'>a relay zafu does not know</span>
          )}
        </span>
      </span>
      <span className='flex justify-end gap-2'>
        <Button variant='quiet' size='sm' disabled={busy} onClick={() => void decline(inv)}>
          no, thank you
        </Button>
        {inv.read.ok && (
          <Button size='sm' disabled={busy || known === undefined} onClick={() => void go()}>
            accept
          </Button>
        )}
      </span>
    </div>
  );
};

export const InviteRows = () => {
  const invites = useMyInvites();
  const { ask, sheet } = useRelayAsk();
  if (!invites.length) {
    return null;
  }
  return (
    <>
      {invites.map(inv => (
        <InviteRow key={inv.id} inv={inv} onAllow={ask} />
      ))}
      {sheet}
    </>
  );
};
