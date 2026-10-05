/**
 * People asking to join a group you made, each with "allow" and "not now".
 * One slot, pinned where it is shown (the invite screen and the group's own
 * thread), so it never scrolls out of sight and never expands in place.
 */

import { useState } from 'react';
import { ZidSeal } from '@repo/ui/components/ui/zid-seal';
import { peopleAsk } from '../../../people/client';
import type { PeopleRoom } from '../../../people/vault';
import { shortXid, xidOf } from '../../../state/identity';
import { distinct } from '../../../people/word-name';
import { useMemberName } from './use-member-name';

/** the founder's open door for a group, and who waits at it */
export const asksOf = (rooms: PeopleRoom[], G: string) => {
  const door = rooms.find(r => r.id === `d:${G}`);
  const open = !!door?.group?.mine && (door.until ?? 0) > Date.now();
  return { door: open ? door : undefined, asks: open ? (door.group?.requests ?? []) : [] };
};

export const JoinAsks = ({ room, door }: { room: PeopleRoom; door: PeopleRoom | undefined }) => {
  const nameFor = useMemberName(room);
  const [busy, setBusy] = useState<string>();
  const G = room.group?.G ?? '';
  const asks = door?.group?.requests ?? [];
  if (!asks.length) {
    return null;
  }
  const shown = distinct(asks.map(a => ({ key: a.key, name: nameFor(a.key, a.name) })));
  const act = (op: string, key: string) => {
    setBusy(key);
    void peopleAsk(op, { G, key })
      .catch(() => undefined)
      .finally(() => setBusy(undefined));
  };
  return (
    <section
      aria-label='asking to join'
      className='flex max-h-[176px] shrink-0 flex-col overflow-y-auto border-b border-gold-line bg-zigner-gold/5 px-4 py-1'
    >
      {asks.map(a => (
        <div key={a.key} className='flex h-14 shrink-0 items-center gap-3'>
          <ZidSeal hex={a.key} size={32} />
          <span className='flex min-w-0 grow flex-col gap-[3px]'>
            <span className='truncate text-sm text-fg-high'>{shown.get(a.key)}</span>
            <span className='truncate text-[11px] text-fg-muted'>
              wants to join · XID({shortXid(xidOf(a.key))})
            </span>
          </span>
          <button
            type='button'
            disabled={busy === a.key}
            onClick={() => act('group-decline', a.key)}
            className='h-8 shrink-0 px-2 text-xs text-fg-muted hover:text-fg-high'
          >
            not now
          </button>
          <button
            type='button'
            disabled={busy === a.key}
            onClick={() => act('group-allow', a.key)}
            className='h-8 shrink-0 bg-zigner-gold px-3 text-xs text-zigner-gold-foreground hover:bg-zigner-gold-light disabled:opacity-60'
          >
            allow
          </button>
        </div>
      ))}
    </section>
  );
};
