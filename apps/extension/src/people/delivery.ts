/**
 * A line reaching someone who was away longer than the relay keeps it (48 h).
 *
 * Resend, always on and telling no one anything: while zafu is open, your own
 * lines in a 1:1 chat from the last {@link RESEND_FOR_MS} go to the relay
 * again every {@link RESEND_AFTER_MS}, as `zp2:again:<id>:<ts>:<m|a>:<words>`.
 * The id is the first record's hash, so the other side files it under the line
 * it already has (or shows it once, if it never had it). An older zafu hides
 * every `zp2:` line and sees only the first.
 *
 * Read receipts, per chat and off by default: with them on, reading a thread
 * says `zp2:seen:<ts>` (everything up to then is read), and a line of theirs
 * the other side reports read stops going again. Each side sees the other's
 * only while its own are on.
 */

import type { RoomMessage } from '@zafu/zirc/room';
import type { PeopleService, RecordHandler } from './service';
import type { ThreadItem } from './vault';

export const AGAIN = 'zp2:again:';
export const SEEN = 'zp2:seen:';

/** under the relay's 48 h, so a line is always there to find */
export const RESEND_AFTER_MS = 40 * 3600_000;
/** how long a line keeps going again */
export const RESEND_FOR_MS = 7 * 24 * 3600_000;

export const againBody = (it: Pick<ThreadItem, 'hash' | 'ts' | 'kind' | 'body'>): string =>
  `${AGAIN}${it.hash}:${it.ts}:${it.kind === 'action' ? 'a' : 'm'}:${it.body}`;

/** a line said again, as the thread files it: under the first record's id and time */
export const fromAgain = (m: RoomMessage, me: string): ThreadItem | undefined => {
  const parts = /^zp2:again:([0-9a-f]{16,128}):(\d{1,12}):([ma]):([\s\S]*)$/.exec(m.body);
  if (!parts) {
    return undefined;
  }
  const [, hash, ts, kind, body] = parts;
  return {
    hash: hash!,
    author: m.author,
    name: m.name,
    body: body!,
    ts: Number(ts),
    epoch: m.epoch,
    kind: kind === 'a' ? 'action' : 'msg',
    mine: m.author === me,
  };
};

/** your lines on the relay, young enough, not read yet and not said again lately */
export const dueAgain = (items: ThreadItem[], seenUpTo: number, now: number): ThreadItem[] =>
  items.filter(
    i =>
      i.mine &&
      i.hash &&
      !i.status &&
      i.kind !== 'note' &&
      i.ts > seenUpTo &&
      now - i.ts * 1000 < RESEND_FOR_MS &&
      now - (i.posted ?? i.ts * 1000) >= RESEND_AFTER_MS,
  );

/** the latest "read up to" of theirs among these records */
export const seenOf = (
  records: RoomMessage[],
  peer: string,
): { upTo: number; at: number } | undefined =>
  records
    .filter(m => m.author === peer && m.body.startsWith(SEEN))
    .map(m => ({ upTo: Number(m.body.slice(SEEN.length)), at: m.ts }))
    .filter(s => Number.isFinite(s.upTo))
    .sort((a, b) => a.upTo - b.upTo)
    .at(-1);

/** their "read up to" in a 1:1 chat, kept on the room */
export const onSeen: RecordHandler = async (room, records) => {
  const s = room.pair?.peer ? seenOf(records, room.pair.peer) : undefined;
  return s && s.upTo > (room.pair?.seen?.upTo ?? 0)
    ? r => ({ ...r, pair: { ...r.pair!, seen: s } })
    : undefined;
};

export const deliveryOps = {
  /** read receipts in one chat, on or off */
  'pair-receipts': async (r: Record<string, unknown>, svc: PeopleService) => {
    const on = r['on'] === true;
    await svc.api.updateRoom(String(r['roomId']), x =>
      x.kind === 'pair' ? { ...x, pair: { ...x.pair!, receipts: on } } : x,
    );
    return on;
  },
};
