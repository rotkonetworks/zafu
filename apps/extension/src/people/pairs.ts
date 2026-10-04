/**
 * 1:1 pair rooms (design-social 2.5): two people who hold each other's cards
 * share a two-member sealed zirc room whose secret both derive from the
 * cards (X25519 of the two relationship KA keys), with no invite and no
 * handshake. It is free and instant text; money stays a memo.
 *
 * Every window has its own shard, derived from the pair secret, so the relay
 * cannot follow one pair across windows. Only the two relationship keys may
 * speak in it; a line signed by anyone else is not shown.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { GROUP_ROOM_PLAINTEXT_BYTES } from '@zafu/zirc/room';
import { isMutual, type Contact } from '../state/contacts';
import { pairSecret, xidOf, type RelationshipKeys } from '../state/identity';
import type { PeopleService } from './service';
import type { PeopleRoom } from './vault';
import { pairId } from './protocol';

export const PAIR_SCOPE = 'zafu-pair-v1';

export { pairId } from './protocol';

export { pairShard } from './shard';

export interface PairDeps {
  walletId: () => Promise<string | undefined>;
  contacts: () => Promise<Contact[]>;
  relKeys: (walletId: string, gen: number, j: number) => Promise<RelationshipKeys>;
  relay: () => Promise<string>;
  now?: () => number;
}

/** the pair room two mutual cards make, as the vault keeps it */
export const pairRoomOf = (
  contact: Contact,
  keys: Pick<RelationshipKeys, 'kaSeed' | 'xid'>,
  relay: string,
  at: number,
): PeopleRoom => ({
  id: pairId(contact.id),
  walletId: contact.rel!.walletId,
  kind: 'pair',
  name: contact.name,
  appScope: PAIR_SCOPE,
  secret: bytesToHex(pairSecret(keys.kaSeed, contact.pairKa!, keys.xid, xidOf(contact.zid!))),
  size: GROUP_ROOM_PLAINTEXT_BYTES,
  relay,
  signer: { gen: contact.rel!.gen, j: contact.rel!.j },
  joined: true,
  createdAt: at,
  pair: { personId: contact.id, peer: contact.zid! },
});

export const createPairs = (deps: PairDeps) => {
  const now = deps.now ?? (() => Date.now());

  /** join the pair room for a person you hold a card from and gave yours to */
  const join = async (svc: PeopleService, contactId: string) => {
    const walletId = await deps.walletId();
    const contact = (await deps.contacts()).find(c => c.id === contactId);
    if (!contact || !isMutual(contact, walletId)) {
      return { joined: false };
    }
    const have = await svc.api.room(pairId(contactId));
    if (
      have?.joined &&
      have.pair?.peer === contact.zid &&
      have.signer.gen === contact.rel!.gen &&
      have.signer.j === contact.rel!.j
    ) {
      return { joined: true, id: have.id };
    }
    const keys = await deps.relKeys(contact.rel!.walletId, contact.rel!.gen, contact.rel!.j);
    const room = pairRoomOf(contact, keys, have?.relay ?? (await deps.relay()), now());
    await svc.api.addRoom({ ...room, since: have?.since, head: have?.head });
    return { joined: true, id: room.id };
  };

  return {
    ops: {
      'pair-join': (r: Record<string, unknown>, s: PeopleService) =>
        join(s, String(r['contactId'])),
    },
  };
};
