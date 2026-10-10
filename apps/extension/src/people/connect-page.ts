/**
 * The page half of an introduction (people/connect): what needs the
 * recovery phrase or the contact book runs here, in a zafu window.
 *
 *   start: after a yes, the meeting room is kept and, on the card side, a
 *          card made for this person is shown into it;
 *   steps: on whichever screen is open (people/keeper), the answer side
 *          answers the card that arrived, and the card side takes the answer
 *          its card got. Either way the person is saved, "introduced by" the site.
 */

import { useEffect } from 'react';
import { bytesToHex } from '@noble/hashes/utils';
import type { ZafuConnectPeer } from '@zafu/protocol';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';
import {
  connectSecret,
  currentIdentityName,
  deriveZidForSite,
  deriveZidKaForSite,
} from '../state/identity';
import {
  defaultPeopleRelay,
  PEOPLE_RELAY_KEY,
  type PeopleRelaySetting,
} from '../config/people-relay';
import { peopleAsk, peopleCall } from './client';
import { readB64Card } from './cards';
import { connectRole, connectRoom, connectRoomId } from './connect';
import { addressesOf, givenOf, useMyCards } from './my-card';
import type { PeopleRoom } from './vault';

/** say yes to an introduction: the meeting room, and on the card side the card */
export const useStartConnect = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const cards = useMyCards();
  return async (origin: string, peer: ZafuConnectPeer, name: string) => {
    if (!keyInfo || !cards.ready) {
      throw new Error("this wallet doesn't make cards · a phrase or zigner wallet does");
    }
    const mnemonic = await getMnemonic(keyInfo.id);
    const id = await currentIdentityName();
    const mine = deriveZidForSite(mnemonic, id, origin).publicKey;
    const ka = deriveZidKaForSite(mnemonic, id, origin);
    const secret = bytesToHex(connectSecret(ka.seed, peer.ka, mine, peer.pubkey, origin));
    ka.seed.fill(0);
    const relay = defaultPeopleRelay(
      (await chrome.storage.local.get(PEOPLE_RELAY_KEY))[PEOPLE_RELAY_KEY] as
        | PeopleRelaySetting
        | undefined,
    );
    const role = connectRole(mine, peer.pubkey);
    const introduced = { origin, peer: peer.pubkey, name };
    const at = Date.now();
    if (role === 'card') {
      const c = await cards.fresh();
      await peopleAsk('card-open', {
        card: c.b64,
        contactId: c.contactId,
        gen: c.rel.gen,
        j: c.rel.j,
        introduced,
      });
      const room = connectRoom(
        keyInfo.id,
        { ...introduced, name, role, secret, ...c.rel, contactId: c.contactId },
        relay,
        at,
      );
      await peopleAsk('connect-open', { room });
      await peopleAsk('connect-show', { id: room.id, card: c.b64 });
      return;
    }
    const rel = await cards.newRel();
    const room = connectRoom(
      keyInfo.id,
      { ...introduced, name, role, secret, gen: rel.gen, j: rel.j, contactId: crypto.randomUUID() },
      relay,
      at,
    );
    await peopleAsk('connect-open', { room });
  };
};

/** one step at a time per introduction */
const busy = new Set<string>();
const once = (key: string, fn: () => Promise<unknown>) => {
  if (busy.has(key)) {
    return;
  }
  busy.add(key);
  void fn()
    .catch((e: unknown) =>
      console.warn('[connect] a step did not finish; it is tried again:', String(e)),
    )
    .finally(() => busy.delete(key));
};

/** finish the introductions whose other half arrived (mounted by people/keeper) */
export const useConnectSteps = (rooms: PeopleRoom[]) => {
  const cards = useMyCards();
  const addContact = useStore(s => s.contacts.addContact);
  const answering = rooms.filter(r => r.connect?.role === 'answer' && r.connect.state === 'card');
  const taking = rooms.filter(
    r => r.card?.introduced && r.card.state === 'waiting' && r.card.answers?.length,
  );
  const sig = [...answering, ...taking].map(r => r.id).join('|');
  useEffect(() => {
    for (const r of answering) {
      once(r.id, async () => {
        const c = r.connect!;
        const theirs = readB64Card(c.card);
        if (!theirs || r.signer.j === undefined || !cards.ready) {
          return;
        }
        const rel = { walletId: r.walletId, gen: r.signer.gen, j: r.signer.j };
        const answer = await cards.answer(theirs, c.contactId, rel);
        await addContact({
          id: c.contactId,
          name: theirs.name || r.name || 'someone',
          zid: theirs.key,
          pairKa: theirs.pairKa,
          rel,
          addresses: addressesOf(theirs),
          cardV2: c.card,
          source: 'app',
          introduced: { origin: c.origin, handle: c.peer, at: Date.now() },
          given: givenOf(answer.card),
        });
        await peopleAsk('card-answer', {
          theirs: c.card,
          answer: answer.b64,
          contactId: c.contactId,
          gen: rel.gen,
          j: rel.j,
        });
        await peopleCall('connect-done', { id: r.id });
      });
    }
    for (const r of taking) {
      once(r.id, async () => {
        // only the person the site named can read the meeting room, so its first answer is them
        const key = readB64Card(r.card!.answers![0]!.b64)?.key;
        if (!key) {
          return;
        }
        await peopleCall('card-choose', { roomId: r.id, key, checked: false });
        const i = r.card!.introduced!;
        await peopleCall('connect-done', { id: connectRoomId(i.origin, i.peer) });
      });
    }
    // which rooms wait, not each copy of them, decides a new step
  }, [sig]);
};
