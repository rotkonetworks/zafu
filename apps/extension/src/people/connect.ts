/**
 * Introductions (zafu_connect): an app that holds two people's site keys asks
 * each zafu, once, to connect them - two players at a poker table who want to
 * play again. When both have said yes they meet in a room only their two
 * wallets can derive (state/identity `connectSecret`: X25519 of the two site
 * KA keys, bound to the site), and the card flow runs inside it unchanged:
 *
 *   the side whose site key sorts lower shows a card into the room;
 *   the other side answers it as if it had opened a card link;
 *   the card's own pass takes that answer (nobody else can read the room, so
 *   it is the person the app named), and the pair room follows.
 *
 * Nothing is paid and nothing is typed. The app learns no "no": a connect is
 * `pending` until both said yes, and only then shows in zafu_friends. The app
 * could hand over a wrong key, so the person stays "seal not checked" until
 * compared, like anyone met by link.
 *
 * The meeting room lives under the pair scope, kept as long as pair rooms: one
 * person may say yes days after the other.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { GROUP_ROOM_PLAINTEXT_BYTES, type RoomMessage } from '@zafu/zirc/room';
import { presenceEpoch } from '@zafu/zid';
import { CARD_BODY, readB64Card } from './cards';
import { PAIR_SCOPE } from './pairs';
import type { PeopleService } from './service';
import type { PeopleRoom } from './vault';

/** the meeting room of one introduction: one per (site, the other person's site key) */
export const connectRoomId = (origin: string, peer: string): string =>
  `i:${bytesToHex(sha256(new TextEncoder().encode(origin + '\0' + peer))).slice(0, 32)}`;

/** who shows the card: the lower site key, so the two sides never both do */
export const connectRole = (mine: string, peer: string): 'card' | 'answer' =>
  mine < peer ? 'card' : 'answer';

/** a connect room, as the vault keeps it */
export const connectRoom = (
  walletId: string,
  c: {
    origin: string;
    peer: string;
    name: string;
    role: 'card' | 'answer';
    secret: string;
    gen: number;
    j: number;
    contactId: string;
  },
  relay: string,
  at: number,
): PeopleRoom => ({
  id: connectRoomId(c.origin, c.peer),
  walletId,
  kind: 'connect',
  name: c.name,
  appScope: PAIR_SCOPE,
  secret: c.secret,
  size: GROUP_ROOM_PLAINTEXT_BYTES,
  relay,
  signer: { gen: c.gen, j: c.j },
  joined: true,
  createdAt: at,
  since: presenceEpoch(Math.floor(at / 1000)),
  connect: {
    origin: c.origin,
    peer: c.peer,
    role: c.role,
    contactId: c.contactId,
    state: 'waiting',
    at,
  },
});

/** the answer side reads the card the other side showed; the page answers it (people/keeper) */
export const onConnect = async (room: PeopleRoom, records: RoomMessage[]) => {
  const c = room.connect;
  if (!c || c.role !== 'answer' || c.state !== 'waiting') {
    return undefined;
  }
  const b64 = records
    .map(m => (m.body.startsWith(CARD_BODY) ? m.body.slice(CARD_BODY.length) : ''))
    .find(b => readB64Card(b)?.kind === 'card');
  return b64
    ? (r: PeopleRoom) => ({ ...r, connect: { ...r.connect!, state: 'card' as const, card: b64 } })
    : undefined;
};

const str = (r: Record<string, unknown>, k: string) => String(r[k] ?? '');

export const connectOps = {
  /** keep the meeting room (an introduction you said yes to); a second yes changes nothing */
  'connect-open': async (r: Record<string, unknown>, svc: PeopleService) => {
    const room = r['room'] as PeopleRoom;
    if (!(await svc.api.room(room.id))) {
      await svc.api.addRoom(room);
    }
    return { id: room.id };
  },
  /** the card side shows its card into the meeting room */
  'connect-show': async (r: Record<string, unknown>, svc: PeopleService) => {
    await svc.api.send(str(r, 'id'), CARD_BODY + str(r, 'card'), 'action');
    await svc.api.updateRoom(str(r, 'id'), x => ({
      ...x,
      connect: { ...x.connect!, state: 'card' },
    }));
    return { ok: true };
  },
  /** the pair room is made: the meeting room is no longer read */
  'connect-done': async (r: Record<string, unknown>, svc: PeopleService) => {
    await svc.api.updateRoom(str(r, 'id'), x => ({
      ...x,
      joined: false,
      connect: { ...x.connect!, state: 'done' },
    }));
    return { ok: true };
  },
};
