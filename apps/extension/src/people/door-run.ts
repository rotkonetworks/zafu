/**
 * A door's SPAKE2 side (people/door), the part that needs zafu-wasm and so
 * runs where a zafu window is open (people/keeper): the inviter answering
 * each joiner with a run of its own, a joiner speaking to the inviter's hello
 * and opening the box. The worker only carries records; every step here is safe to run
 * again, since what the room kept decides what was done.
 */

import { hexToBytes } from '@noble/hashes/utils';
import { presenceEpoch } from '@zafu/zid';
import type { DoorAnswer, DoorFinish, DoorPakeCall } from '../workers/door-pake';
import {
  ANSWERS_PER_CODE,
  DOOR_VERSION,
  SALTS_TRIED,
  b64,
  openBox,
  runSeed,
  sealBox,
  sessionOf,
  splitCode,
  unb64,
  type DoorWire,
  type InviteBody,
} from './door';
import type { PeopleRoom } from './vault';
import { genesisId, pakeHash, type Invite } from '@zafu/zirc/leaderless';

export type DoorPake = <T>(call: DoorPakeCall) => Promise<T>;
export type DoorCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const wiresOf = <K extends DoorWire['kind']>(door: PeopleRoom, kind: K) =>
  (door.door?.heard ?? []).flatMap(h =>
    h.wire.kind === kind && h.wire.v === DOOR_VERSION
      ? [{ ...h, wire: h.wire as Extract<DoorWire, { kind: K }> }]
      : [],
  );

/** the invite a door answers, as its owner says it in the room (lx) */
export const inviteFor = (door: PeopleRoom, group: PeopleRoom, owner: string): Invite => ({
  G: genesisId(group.group!.g!),
  owner,
  plate: splitCode(door.door!.code)!.plate,
  salt: door.door!.salt!,
  expiry: Math.floor((door.until ?? 0) / 1000),
});

/** what the inviter's group hands a joiner, read from the group as it is now */
export const inviteOf = (group: PeopleRoom, I: Invite): InviteBody => {
  const g = group.group!;
  return {
    secret: group.secret,
    relay: group.relay,
    group: group.name,
    G: g.G,
    g: g.g!,
    I,
    from: g.names?.[I.owner] ?? group.nick ?? '',
    born: presenceEpoch(Math.floor(group.createdAt / 1000)),
  };
};

/**
 * The inviter: answer each run that spoke to this code, then send the invite
 * to the first whose confirmation holds. One box, and the code is spent: the
 * run it went to is kept (its transcript and key), so the one join that
 * comes through it is the one this device co-signs.
 */
export const hostStep = async (
  door: PeopleRoom,
  group: PeopleRoom | undefined,
  pake: DoorPake,
  call: DoorCall,
): Promise<void> => {
  const d = door.door;
  const words = d && splitCode(d.code)?.words;
  const g = group?.group;
  const owner = d?.owner;
  if (d?.role !== 'host' || !owner || !words || !d.seed || d.admitted || !g?.g || g.gone) {
    return;
  }
  // a shared wallet with every seat taken lets nobody else in
  if (g.g.purpose === 'wallet' && g.members.length >= g.g.n) {
    return;
  }
  const run = (jid: string) => ({
    words,
    session: sessionOf(d.salt!, jid),
    seed: runSeed(d.seed!, jid),
  });
  const said = new Map(
    wiresOf(door, 'wj')
      .filter(h => h.wire.salt === d.salt)
      .map(h => [h.wire.jid, h.wire.y]),
  );
  const done = new Set((d.answered ?? []).map(a => a.jid));
  for (const { wire } of wiresOf(door, 'wk')) {
    const y = said.get(wire.jid);
    const x = d.answered?.find(a => a.jid === wire.jid)?.x;
    if (wire.salt !== d.salt || !done.has(wire.jid) || !y || !x) {
      continue;
    }
    const key = await pake<string | null>({ step: 'admit', ...run(wire.jid), y, tag: wire.tag });
    if (key) {
      const box = await sealBox(hexToBytes(key), inviteOf(group!, inviteFor(door, group!, owner)));
      await call('door-admit', {
        roomId: door.id,
        jid: wire.jid,
        box: b64(box),
        th: pakeHash(d.salt, wire.jid, x, y),
        mk: key,
      });
      return;
    }
  }
  for (const [jid, y] of said) {
    if (done.size >= ANSWERS_PER_CODE) {
      return;
    }
    if (done.has(jid)) {
      continue;
    }
    done.add(jid);
    const a = await pake<DoorAnswer | null>({ step: 'answer', ...run(jid), y });
    if (a) {
      await call('door-answer', { roomId: door.id, jid, salt: d.salt, ...a });
    }
  }
};

/**
 * A joiner: speak to each inviter's hello on this number (a few, newest
 * first: codes that share a number tell apart by their words), say back to
 * the answer whose tag holds, and open the box it sends. A box that went to
 * someone else: the code was used. Every inviter answered and none held: the
 * words differ.
 */
export const joinStep = async (door: PeopleRoom, pake: DoorPake, call: DoorCall): Promise<void> => {
  const d = door.door;
  const words = d && splitCode(d.code)?.words;
  if (d?.role !== 'join' || !words || !d.jid || !d.seed || d.G || d.wrong || d.used) {
    return;
  }
  const run = (salt: string) => ({ words, session: sessionOf(salt, d.jid!), seed: d.seed! });
  const salts = [
    ...new Set(
      wiresOf(door, 'wh')
        .sort((a, b) => b.at - a.at)
        .map(h => h.wire.salt),
    ),
  ].slice(0, SALTS_TRIED);
  for (const salt of salts.filter(s => !d.sent?.includes(s))) {
    const y = await pake<string>({ step: 'speak', ...run(salt) });
    await call('door-join', { roomId: door.id, salt, y });
  }
  const boxes = wiresOf(door, 'wb').filter(b => d.sent?.includes(b.wire.salt));
  const answers = wiresOf(door, 'wa').filter(
    a => a.wire.jid === d.jid && d.sent?.includes(a.wire.salt),
  );
  const held = new Set<string>();
  for (const { wire } of answers) {
    const r = await pake<DoorFinish | null>({
      step: 'finish',
      ...run(wire.salt),
      x: wire.x,
      tag: wire.tag,
    });
    if (!r) {
      continue;
    }
    held.add(wire.salt);
    const box = boxes.find(b => b.wire.salt === wire.salt && b.wire.jid === d.jid);
    const invite =
      box && (await openBox(hexToBytes(r.key), unb64(box.wire.box)).catch(() => undefined));
    if (invite) {
      // this run's transcript, as the inviter holds it too: the join it co-signs names it
      const y = await pake<string>({ step: 'speak', ...run(wire.salt) });
      await call('door-enter', {
        roomId: door.id,
        invite,
        words: r.words,
        th: pakeHash(wire.salt, d.jid, wire.x, y),
        mk: r.key,
      });
      return;
    }
    if (!d.confirmed?.includes(wire.salt)) {
      await call('door-confirm', { roomId: door.id, salt: wire.salt, tag: r.tag });
    }
  }
  const taken = new Set(boxes.filter(b => b.wire.jid !== d.jid).map(b => b.wire.salt));
  const answeredBy = new Set(answers.map(a => a.wire.salt));
  const settled = (s: string) => taken.has(s) || (answeredBy.has(s) && !held.has(s));
  if (!d.sent?.length || !d.sent.every(settled)) {
    return;
  }
  await call(d.sent.some(s => taken.has(s)) ? 'door-used' : 'door-wrong', { roomId: door.id });
};

/** what a joiner's door shows */
export type DoorView =
  | 'reading'
  | 'nothing'
  /** the inviter's zafu speaks a newer door, or an older one */
  | 'newer'
  | 'older'
  | 'waiting'
  | 'wrong'
  /** the code had already let someone else in */
  | 'used'
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
  if (d.used) {
    return 'used';
  }
  if ((door.until ?? 0) <= nowMs) {
    return 'closed';
  }
  if (d.sent?.length) {
    return 'waiting';
  }
  const hellos = d.heard.flatMap(h => (h.wire.kind === 'wh' ? [h.wire.v] : []));
  return hellos.includes(DOOR_VERSION)
    ? 'reading'
    : hellos.some(v => v > DOOR_VERSION)
      ? 'newer'
      : hellos.length
        ? 'older'
        : 'nothing';
};
