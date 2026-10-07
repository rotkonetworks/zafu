/**
 * A door's SPAKE2 side (people/door), the part that needs zafu-wasm and so
 * runs where a screen is open: the founder answering each joiner with a run
 * of its own, a joiner speaking to the founder's hello and opening the
 * answer. The worker only carries records; every step here is safe to run
 * again, since what the room kept decides what was done.
 */

import { hexToBytes } from '@noble/hashes/utils';
import type { DoorAnswer, DoorPakeCall } from '../workers/door-pake';
import {
  ANSWERS_PER_CODE,
  DOOR_VERSION,
  SALTS_TRIED,
  b64,
  openBox,
  sealBox,
  sessionOf,
  splitCode,
  unb64,
  type DoorWire,
  type InviteBody,
} from './door';
import type { PeopleRoom } from './vault';

export type DoorPake = <T>(call: DoorPakeCall) => Promise<T>;
export type DoorCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const wiresOf = <K extends DoorWire['kind']>(door: PeopleRoom, kind: K) =>
  (door.door?.heard ?? []).flatMap(h =>
    h.wire.kind === kind ? [{ ...h, wire: h.wire as Extract<DoorWire, { kind: K }> }] : [],
  );

/** what the founder's group hands a joiner, read from the group as it is now */
export const inviteOf = (group: PeopleRoom): InviteBody => {
  const g = group.group!;
  return {
    secret: group.secret,
    relay: group.relay,
    group: group.name,
    G: g.G,
    founder: g.founder,
    from: g.names?.[g.founder] ?? '',
    ...(g.want ? { want: { k: g.want.k, n: g.want.n } } : {}),
  };
};

/** the founder: one fresh run per joiner who spoke to this code, until the door is full */
export const hostStep = async (
  door: PeopleRoom,
  group: PeopleRoom | undefined,
  pake: DoorPake,
  call: DoorCall,
): Promise<void> => {
  const d = door.door;
  const words = d && splitCode(d.code)?.words;
  if (d?.role !== 'host' || !words || !group?.group?.mine) {
    return;
  }
  const want = group.group.want;
  const done = new Set((d.answered ?? []).map(a => a.jid));
  for (const { wire } of wiresOf(door, 'wj')) {
    const full = want && (want.started || group.group.members.length >= want.n);
    if (full || done.size >= ANSWERS_PER_CODE) {
      return;
    }
    if (wire.v !== DOOR_VERSION || wire.salt !== d.salt || done.has(wire.jid)) {
      continue;
    }
    done.add(wire.jid);
    const a = await pake<DoorAnswer>({
      step: 'answer',
      words,
      session: sessionOf(wire.salt, wire.jid),
      y: wire.y,
    });
    const box = await sealBox(hexToBytes(a.key), inviteOf(group));
    await call('door-answer', {
      roomId: door.id,
      jid: wire.jid,
      salt: wire.salt,
      x: a.x,
      tag: a.tag,
      box: b64(box),
      words: a.words,
    });
  }
};

/**
 * A joiner: speak to each founder's hello on this number (a few, newest
 * first: codes that share a number tell apart by their words), then open
 * the first answer whose tag holds. Every founder spoken to answered and
 * none held: the words differ.
 */
export const joinStep = async (door: PeopleRoom, pake: DoorPake, call: DoorCall): Promise<void> => {
  const d = door.door;
  const words = d && splitCode(d.code)?.words;
  if (d?.role !== 'join' || !words || !d.jid || !d.seed || d.G || d.wrong) {
    return;
  }
  const session = (salt: string) => sessionOf(salt, d.jid!);
  const salts = [
    ...new Set(
      wiresOf(door, 'wh')
        .filter(h => h.wire.v === DOOR_VERSION)
        .sort((a, b) => b.at - a.at)
        .map(h => h.wire.salt),
    ),
  ].slice(0, SALTS_TRIED);
  for (const salt of salts.filter(s => !d.sent?.includes(s))) {
    const y = await pake<string>({ step: 'speak', words, session: session(salt), seed: d.seed });
    await call('door-join', { roomId: door.id, salt, y });
  }
  const answers = wiresOf(door, 'wa').filter(
    a => a.wire.v === DOOR_VERSION && a.wire.jid === d.jid && d.sent?.includes(a.wire.salt),
  );
  for (const { wire } of answers) {
    const r = await pake<{ key: string; words: string } | null>({
      step: 'finish',
      words,
      session: session(wire.salt),
      seed: d.seed,
      x: wire.x,
      tag: wire.tag,
    });
    const invite = r && (await openBox(hexToBytes(r.key), unb64(wire.box)).catch(() => undefined));
    if (r && invite) {
      await call('door-enter', { roomId: door.id, invite, words: r.words });
      return;
    }
  }
  const answeredBy = new Set(answers.map(a => a.wire.salt));
  if (d.sent?.length && d.sent.every(s => answeredBy.has(s))) {
    await call('door-wrong', { roomId: door.id });
  }
};

/** what a joiner's door shows */
export type DoorView =
  | 'reading'
  | 'nothing'
  /** the founder's zafu speaks a newer door */
  | 'newer'
  | 'waiting'
  | 'wrong'
  | 'closed'
  | 'in';

export const doorView = (door: PeopleRoom | undefined, nowMs: number): DoorView => {
  const d = door?.door;
  if (!d) {
    return 'reading';
  }
  if (d.G) {
    return 'in';
  }
  if (d.wrong) {
    return 'wrong';
  }
  if ((door.until ?? 0) <= nowMs) {
    return 'closed';
  }
  const hellos = wiresOf(door, 'wh');
  if (d.sent?.length) {
    return 'waiting';
  }
  if (hellos.some(h => h.wire.v === DOOR_VERSION)) {
    return 'reading';
  }
  return hellos.some(h => h.wire.v > DOOR_VERSION) ? 'newer' : 'nothing';
};
