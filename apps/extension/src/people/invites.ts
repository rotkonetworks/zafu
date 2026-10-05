/**
 * Memo invites on the worker side: what the memo sync hands over, kept until
 * the person answers, and what "accept" joins. Declining or ignoring one
 * never contacts any relay; accepting contacts the relay the sender named,
 * and only once that relay is allowed (an unknown one by an explicit allow).
 *
 * THE MEMO-INGEST SEAM. Every decoded memo that carries `zafu:m1/` reaches
 * here through one internal message, `zafu_people` op `memo-ingest`
 * ({ network, txId, content, at, from? }). The zcash and penumbra memo syncs
 * call it (`ingestMemoInvites` in ./client); a test, with no testnet to mine
 * a memo on, calls the same op from a zafu page. It is internal only: the
 * listener refuses anything that is not zafu's own page, so a site cannot
 * plant an invite.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { DEFAULT_PEOPLE_RELAY } from '../config/people-relay';
import { GROUP_ROOM_PLAINTEXT_BYTES, ZAFU_GROUP_APP_SCOPE } from '@zafu/zirc/room';
import { readCardPayload } from '../state/contact-share';
import type { Contact } from '../state/contacts';
import type { XidKeys } from '../state/identity';
import { wordName } from './word-name';
import { encodeWire } from './door';
import { groupId } from './groups';
import { hasMemoInvite, readMemoInvite } from './memo-door';
import { PAIR_SCOPE } from './pairs';
import { pairId } from './protocol';
import type { PeopleService, RecordHandler } from './service';
import {
  readInvites,
  writeInvites,
  type PairCard,
  type PeopleRoom,
  type StoredInvite,
} from './vault';

export interface InviteDeps {
  walletId: () => Promise<string | undefined>;
  contacts: () => Promise<Contact[]>;
  /** room keys, for answering a group invite with an ask */
  roomKeys: (walletId: string, gen: number, G: string) => Promise<XidKeys>;
  generation: (walletId: string) => Promise<number>;
  relay: () => Promise<string>;
  now?: () => number;
  read?: () => Promise<StoredInvite[]>;
  write?: (all: StoredInvite[]) => Promise<boolean>;
}

export const createInvites = (deps: InviteDeps) => {
  const now = deps.now ?? (() => Date.now());
  const read = deps.read ?? readInvites;
  const write = deps.write ?? writeInvites;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const ingest = async (r: Record<string, unknown>) => {
    const content = String(r['content'] ?? '');
    const id = String(r['txId'] ?? '');
    const walletId = await deps.walletId();
    const parsed = readMemoInvite(content);
    if (!hasMemoInvite(content) || !parsed || !id || !walletId) {
      return { stored: false };
    }
    return serial(async () => {
      const all = await read();
      if (all.some(i => i.id === id && i.walletId === walletId)) {
        return { stored: false };
      }
      await write([
        ...all,
        {
          id,
          walletId,
          network: r['network'] === 'penumbra' ? 'penumbra' : 'zcash',
          at: Number(r['at']) || now(),
          ...(typeof r['from'] === 'string' && r['from'] ? { from: r['from'] } : {}),
          read: parsed,
          state: 'open',
        },
      ]);
      return { stored: true };
    });
  };

  const settle = (id: string, state: StoredInvite['state']) =>
    serial(async () => {
      const walletId = await deps.walletId();
      await write(
        (await read()).map(i => (i.id === id && i.walletId === walletId ? { ...i, state } : i)),
      );
    });

  const find = async (id: string) => {
    const walletId = await deps.walletId();
    return (await read()).find(i => i.id === id && i.walletId === walletId && i.state === 'open');
  };

  /**
   * Join what an invite opens. A pair: the room the sender made, under the
   * relationship you minted for them (the screen saved them as a contact
   * first), then your card into it so they learn who answered. A group: its
   * room, then an ask with your room key so the founder puts you on the roster.
   */
  const accept = async (svc: PeopleService, r: Record<string, unknown>) => {
    const stored = await find(String(r['id']));
    if (!stored?.read.ok) {
      throw new Error('this invite is no longer open');
    }
    const invite = stored.read.invite;
    // '' is the built-in relay, whatever this wallet's own default is
    const relay = invite.relay || DEFAULT_PEOPLE_RELAY;
    const at = now();
    if (invite.kind === 'pair') {
      const contact = (await deps.contacts()).find(c => c.id === String(r['contactId']));
      if (!contact?.rel || typeof r['card'] !== 'string') {
        throw new Error('save them first');
      }
      const room: PeopleRoom = {
        id: pairId(contact.id),
        walletId: stored.walletId,
        kind: 'pair',
        name: contact.name,
        appScope: PAIR_SCOPE,
        secret: invite.secret,
        size: GROUP_ROOM_PLAINTEXT_BYTES,
        relay,
        signer: { gen: contact.rel.gen, j: contact.rel.j },
        joined: true,
        createdAt: at,
        pair: { personId: contact.id, peer: invite.inception },
      };
      await svc.api.addRoom(room);
      await svc.api.send(room.id, `zp1:card:${r['card']}`, 'action');
      await settle(stored.id, 'accepted');
      return { id: room.id };
    }
    const gen = await deps.generation(stored.walletId);
    const keys = await deps.roomKeys(stored.walletId, gen, invite.G);
    const room: PeopleRoom = {
      id: groupId(invite.G),
      walletId: stored.walletId,
      kind: 'group',
      name: invite.group,
      appScope: ZAFU_GROUP_APP_SCOPE,
      secret: invite.secret,
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay,
      signer: { gen, G: invite.G },
      joined: true,
      createdAt: at,
      group: {
        G: invite.G,
        founder: invite.founder,
        mine: false,
        members: [],
        names: { [invite.founder]: invite.from },
      },
    };
    await svc.api.addRoom(room);
    await svc.api.send(
      room.id,
      encodeWire({
        kind: 'ask',
        key: keys.pubkey,
        name: wordName(keys.pubkey),
        seal: keys.xwingPublicKey,
      }),
      'action',
    );
    await settle(stored.id, 'accepted');
    return { id: room.id };
  };

  /**
   * The sender's side: a pair room whose secret the memo will carry, waiting
   * for the answer. The screen made the relationship (contact.rel) and builds
   * the memo; this keeps the room, so the answer is read on the next pass.
   */
  const open = async (svc: PeopleService, r: Record<string, unknown>) => {
    const walletId = await deps.walletId();
    const contact = (await deps.contacts()).find(c => c.id === String(r['contactId']));
    const secret = String(r['secret'] ?? '');
    if (!walletId || !contact?.rel || !/^[0-9a-f]{64}$/.test(secret)) {
      throw new Error('save them first');
    }
    const relay = typeof r['relay'] === 'string' && r['relay'] ? r['relay'] : DEFAULT_PEOPLE_RELAY;
    await svc.api.addRoom({
      id: pairId(contact.id),
      walletId,
      kind: 'pair',
      name: contact.name,
      appScope: PAIR_SCOPE,
      secret,
      size: GROUP_ROOM_PLAINTEXT_BYTES,
      relay,
      signer: { gen: contact.rel.gen, j: contact.rel.j },
      joined: true,
      createdAt: now(),
      pair: { personId: contact.id, waiting: true },
    });
    return { id: pairId(contact.id) };
  };

  /**
   * A pair room waiting on a memo invite: read the answers. An answer counts
   * when its card is signed by the key it names (the record's author) and
   * answers THIS relationship (its `answers` is the inception key the invite
   * carried, which is this room's own signer). That ties it to this invite,
   * not to the person: whoever can read the memo - its recipient, a viewing
   * key on either side, anything that later sees the memo's plaintext - can
   * answer the same way. So an answer becomes the person only when it carries
   * the key you already hold for them; otherwise it waits for you to say
   * which one is them (`pair-choose`), and a second, different answer is
   * shown beside the first instead of being dropped.
   */
  const onPair: RecordHandler = async (room, records, api) => {
    const me = await api.me(room);
    const fresh = records.flatMap(m => {
      const card =
        m.author !== me && m.body.startsWith('zp1:card:')
          ? readCardPayload(m.body.slice('zp1:card:'.length))
          : undefined;
      return card?.zid === m.author && card.pairKa && card.answers === me
        ? [{ zid: card.zid, pairKa: card.pairKa, address: card.address, name: card.name }]
        : [];
    });
    const seen = new Map<string, PairCard>();
    for (const c of [...(room.pair?.answers ?? []), ...fresh]) {
      if (c.zid !== room.pair?.peer && !seen.has(c.zid)) {
        seen.set(c.zid, c);
      }
    }
    if (!fresh.some(c => c.zid !== room.pair?.peer)) {
      return undefined;
    }
    const contact = (await deps.contacts()).find(c => c.id === room.pair?.personId);
    const all = [...seen.values()];
    // the key you already hold for them, on the same pair key: that is them
    const known =
      !room.pair?.peer && contact?.zid
        ? all.find(c => c.zid === contact.zid && (!contact.pairKa || c.pairKa === contact.pairKa))
        : undefined;
    return r => ({
      ...r,
      pair: known
        ? { ...r.pair!, peer: known.zid, waiting: false, card: known, answers: undefined }
        : { ...r.pair!, waiting: false, answers: all },
    });
  };

  /** you said which answer is them: they become the person in this room */
  const choose = async (svc: PeopleService, r: Record<string, unknown>) => {
    const id = pairId(String(r['contactId'] ?? ''));
    const zid = String(r['zid'] ?? '');
    const room = await svc.api.room(id);
    const card = room?.pair?.answers?.find(c => c.zid === zid);
    if (!card) {
      throw new Error('that answer is not here');
    }
    await svc.api.updateRoom(id, x => ({
      ...x,
      pair: { ...x.pair!, peer: card.zid, waiting: false, card, answers: undefined },
    }));
    return { ok: true };
  };

  return {
    ops: {
      'memo-ingest': (r: Record<string, unknown>) => ingest(r),
      'invite-decline': (r: Record<string, unknown>) => settle(String(r['id']), 'declined'),
      'invite-accept': (r: Record<string, unknown>, s: PeopleService) => accept(s, r),
      'invite-open': (r: Record<string, unknown>, s: PeopleService) => open(s, r),
      'pair-choose': (r: Record<string, unknown>, s: PeopleService) => choose(s, r),
      invites: async () => {
        const walletId = await deps.walletId();
        return (await read()).filter(i => i.walletId === walletId && i.state === 'open');
      },
    },
    handlers: { pair: onPair },
  };
};

/** a fresh room secret for a memo invite */
export const newRoomSecret = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
