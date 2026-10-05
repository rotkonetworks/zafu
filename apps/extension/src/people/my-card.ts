/**
 * Your v2 cards, made where your addresses are (the screens' realm), and the
 * contacts they become. The worker (people/cards) moves them over the relay;
 * this side signs them and keeps the address book in step:
 *
 *  - an answer to a card you showed becomes the person, under the id that
 *    card's address was made for;
 *  - their newer card replaces what you pay and reach them by;
 *  - when what your card for someone says changes (a new address, your relay,
 *    penumbra turned on) - or they are a v1 contact who never had a v2 card
 *    from you - zafu sends them an `update`, once.
 */

import { useEffect, useState } from 'react';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { bech32mAddress, addressFromBech32m } from '@penumbra-zone/bech32m/penumbra';
import {
  Cap,
  answersOf,
  cardB64,
  signCardV2,
  type CardKind,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import {
  encodeOrchardUnifiedAddress,
  orchardReceiverOf,
} from '@repo/wallet/networks/zcash/unified-address';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectEnabledNetworks, selectGetMnemonic } from '../state/keyring';
import { deriveRelationshipKeys, getZidIndex, mintRelationshipIndex } from '../state/identity';
import { myAddressForContact, type AddressSource } from '../state/contact-share';
import { getDiversifiedAddresses, setDiversifiedAddresses } from '../state/diversified-addresses';
import {
  isMutual,
  type Contact,
  type ContactAddress,
  type ContactRel,
  type GivenCard,
} from '../state/contacts';
import { useContactAddressSource } from '../hooks/use-contact-address-source';
import { whenHydrated } from '../state/encrypted-storage';
import { defaultPeopleRelay } from '../config/people-relay';
import { readB64Card } from './cards';
import { peopleCall, useMyRooms } from './client';
import { pairId } from './protocol';
import type { PeopleRoom } from './vault';

/** a card's addresses, as the address book keeps them */
export const addressesOf = (c: CardV2): Omit<ContactAddress, 'id'>[] => [
  ...(c.zcash
    ? [
        {
          network: 'zcash' as const,
          address: encodeOrchardUnifiedAddress(hexToBytes(c.zcash), !c.testnet),
        },
      ]
    : []),
  ...(c.penumbra
    ? [{ network: 'penumbra' as const, address: bech32mAddress({ inner: hexToBytes(c.penumbra) }) }]
    : []),
];

export const givenOf = (c: CardV2): GivenCard => ({
  rev: c.revision,
  ...(c.zcash ? { zcash: c.zcash } : {}),
  ...(c.penumbra ? { penumbra: c.penumbra } : {}),
  relay: c.relay,
  caps: c.caps,
});

/** what your card for one person says right now, before it is signed */
export interface CardNow {
  zcash?: string;
  testnet?: boolean;
  penumbraOn: boolean;
  relay: string;
  caps: number;
}

/** what you gave them no longer says what you would say now: send an update */
export const isStale = (given: GivenCard | undefined, now: CardNow): boolean =>
  !given ||
  given.zcash !== now.zcash ||
  given.relay !== now.relay ||
  given.caps !== now.caps ||
  !!given.penumbra !== now.penumbraOn;

/** a contact's address key: their id, then `id:n` once you gave them a new address */
export const addressKey = (contactId: string, gen?: number) =>
  gen ? `${contactId}:${gen}` : contactId;

/** the person their latest card makes, from a card room you showed and they answered */
export const contactFromAnswer = (
  room: PeopleRoom,
  walletId: string,
): Parameters<ReturnType<typeof useStore.getState>['contacts']['addContact']>[0] | undefined => {
  const answer = readB64Card(room.card?.answer);
  const mine = readB64Card(room.card?.bytes);
  if (!answer || !mine || room.signer.j === undefined || !room.card) {
    return undefined;
  }
  return {
    id: room.card.contactId,
    name: answer.name ?? 'someone',
    zid: answer.key,
    pairKa: answer.pairKa,
    rel: { walletId, gen: room.signer.gen, j: room.signer.j },
    addresses: addressesOf(answer),
    cardV2: room.card.answer,
    source: room.card.via === 'memo' ? 'memo' : 'link',
    ...(room.card.checked ? { sealChecked: room.card.checked } : {}),
    given: givenOf(mine),
  };
};

const minutes = () => Math.floor(Date.now() / 60_000);

/** your address for one person is fixed by their id: derived once per window */
const addrs = new Map<string, ReturnType<typeof myAddressForContact>>();
const addressFor = (walletId: string, key: string, source: AddressSource) => {
  const k = `${walletId}|${key}`;
  const have = addrs.get(k);
  if (have) {
    return have;
  }
  const made = myAddressForContact(key, source);
  addrs.set(k, made);
  void made.then(a => !a && addrs.delete(k));
  return made;
};

/** make and sign your cards: a fresh one for the next person, an answer, an update */
export const useMyCards = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const penumbraOn = useStore(s => selectEnabledNetworks(s).includes('penumbra'));
  const source = useContactAddressSource();

  const now = async (contactId: string, addrGen?: number): Promise<CardNow> => {
    const mine = await addressFor(keyInfo!.id, addressKey(contactId, addrGen), source());
    const raw = mine && orchardReceiverOf(mine.address);
    if (mine) {
      // a payment to this address is known to be theirs
      const records = await getDiversifiedAddresses();
      if (!records.some(r => r.diversifierIndex === mine.index)) {
        await setDiversifiedAddresses([
          ...records,
          {
            diversifierIndex: mine.index,
            sharedWith: contactId,
            address: mine.address,
            sharedAt: Date.now(),
          },
        ]);
      }
    }
    const discovery = (await localExtStorage.get('zidDiscovery'))?.enabled === true;
    return {
      ...(raw ? { zcash: bytesToHex(raw) } : {}),
      ...(mine?.address.startsWith('utest') ? { testnet: true } : {}),
      penumbraOn,
      relay: defaultPeopleRelay(await localExtStorage.get('peopleRelay')),
      caps: Cap.chat | Cap.mailbox | Cap.sealed | (discovery ? Cap.discovery : 0),
    };
  };

  /** a penumbra address of yours for one person: kept once given */
  const penumbra = async (mnemonic: string, kept?: string) => {
    if (kept) {
      return kept;
    }
    const { derivePenumbraEphemeralFromMnemonic } = await import('../hooks/use-address');
    return bytesToHex(
      addressFromBech32m(await derivePenumbraEphemeralFromMnemonic(mnemonic, 0)).inner,
    );
  };

  const make = async (
    kind: CardKind,
    o: {
      contactId: string;
      rel: Pick<ContactRel, 'gen' | 'j'>;
      rev: number;
      answers?: string;
      addrGen?: number;
      given?: GivenCard;
    },
  ): Promise<{ b64: string; card: CardV2 }> => {
    if (keyInfo?.type !== 'mnemonic') {
      throw new Error('this wallet cannot make cards');
    }
    const mnemonic = await getMnemonic(keyInfo.id);
    const at = await now(o.contactId, o.addrGen);
    const keys = deriveRelationshipKeys(mnemonic, o.rel.gen, o.rel.j);
    const card: CardV2 = {
      kind,
      revision: o.rev,
      key: keys.pubkey,
      pairKa: keys.kaPublicKey,
      ...(o.answers ? { answers: o.answers } : {}),
      ...(at.zcash ? { zcash: at.zcash } : {}),
      ...(at.testnet ? { testnet: true } : {}),
      ...(at.penumbraOn ? { penumbra: await penumbra(mnemonic, o.given?.penumbra) } : {}),
      relay: at.relay,
      caps: at.caps,
      created: minutes(),
    };
    const b64 = cardB64(signCardV2(card, keys.seed));
    keys.seed.fill(0);
    keys.kaSeed.fill(0);
    keys.xwingSeed.fill(0);
    return { b64, card };
  };

  return {
    ready: keyInfo?.type === 'mnemonic',
    /** this wallet keeps no recovery phrase here (zigner, ledger, a shared wallet): no cards */
    cannot: !!keyInfo && keyInfo.type !== 'mnemonic',
    walletId: keyInfo?.id,
    /** a card for the next person: a fresh relationship and an id their contact will have */
    fresh: async () => {
      const walletId = keyInfo!.id;
      const gen = await getZidIndex(walletId);
      const rel = { gen, j: await mintRelationshipIndex(walletId, gen) };
      const contactId = crypto.randomUUID();
      return { ...(await make('card', { contactId, rel, rev: 0 })), contactId, rel };
    },
    /** your answer to their card, for the person you just saved */
    answer: async (theirs: CardV2, contactId: string, rel: Pick<ContactRel, 'gen' | 'j'>) =>
      make('answer', { contactId, rel, rev: 0, answers: answersOf(theirs.key) }),
    now,
    make,
    newRel: async () => {
      const walletId = keyInfo!.id;
      const gen = await getZidIndex(walletId);
      return { walletId, gen, j: await mintRelationshipIndex(walletId, gen) };
    },
  };
};

const sending = new Set<string>();
/** contacts whose card was checked against these inputs in this window */
const checked = new Set<string>();
/** wallets whose old unanswered cards were let go, and closes retried, in this window */
const swept = new Set<string>();

/**
 * Keep contacts in step with the rooms (mounted on the people screens):
 * answers become people, newer cards replace older ones, a pending
 * confirmation goes out, and a changed or missing card of yours is sent.
 */
export const useCardSync = (): void => {
  const rooms = useMyRooms();
  const contacts = useStore(s => s.contacts.contacts);
  const { addContact, updateContact } = useStore(s => s.contacts);
  const cards = useMyCards();
  const { walletId } = cards;
  const penumbraOn = useStore(s => selectEnabledNetworks(s).includes('penumbra'));
  const [relay, setRelay] = useState<string>();
  // nothing is written before this window read its contacts: a write from the
  // empty list it starts with would replace everyone stored
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    void localExtStorage.get('peopleRelay').then(v => setRelay(defaultPeopleRelay(v)));
    void whenHydrated().then(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!walletId || !hydrated || !Array.isArray(contacts)) {
      return;
    }
    const once = (key: string, fn: () => Promise<unknown>) => {
      if (!sending.has(key)) {
        sending.add(key);
        void fn()
          .catch(() => undefined)
          .finally(() => sending.delete(key));
      }
    };
    const byId = new Map(contacts.map(c => [c.id, c]));
    if (!swept.has(walletId)) {
      swept.add(walletId);
      void peopleCall('card-expire', {}).catch(() => swept.delete(walletId));
    }
    for (const r of rooms) {
      const c = r.card;
      // a close that did not leave last time goes now
      if (r.kind === 'card' && c?.mine && c.state === 'cancelling' && !swept.has(r.id)) {
        swept.add(r.id);
        once(`cancel:${r.id}`, () => peopleCall('card-cancel', { roomId: r.id }));
      }
      if (r.kind === 'card' && c?.mine && c.state === 'answered' && !byId.has(c.contactId)) {
        const data = contactFromAnswer(r, walletId);
        if (data) {
          once(`add:${c.contactId}`, async () => {
            // what is in the store now, not what this render saw
            const now = useStore.getState().contacts.contacts;
            if (Array.isArray(now) && !now.some(x => x.id === c.contactId)) {
              await addContact(data);
            }
          });
        }
      }
      const v2 = r.pair?.v2;
      const person = r.pair && byId.get(r.pair.personId);
      if (!person) {
        continue;
      }
      const latest = readB64Card(v2?.latest);
      if (latest && v2?.latest !== person.cardV2) {
        once(`latest:${person.id}:${latest.revision}`, () =>
          updateContact(person.id, { cardV2: v2!.latest, addresses: addressesOf(latest) }),
        );
      }
      if (v2?.confirmDue) {
        once(`confirm:${person.id}`, () => peopleCall('card-confirm', { contactId: person.id }));
      }
    }
    if (!cards.ready || !relay) {
      return;
    }
    for (const person of contacts) {
      const joined = rooms.some(r => r.id === pairId(person.id) && r.joined);
      const inputs = [person.id, person.addrGen, person.given?.rev, penumbraOn, relay].join('|');
      if (!joined || !isMutual(person, walletId) || checked.has(inputs)) {
        continue;
      }
      once(`give:${person.id}`, () => sendUpdate(person).then(() => checked.add(inputs)));
    }

    async function sendUpdate(person: Contact) {
      const now = await cards.now(person.id, person.addrGen);
      if (!isStale(person.given, now)) {
        return;
      }
      const { b64, card } = await cards.make('update', {
        contactId: person.id,
        rel: person.rel!,
        rev: (person.given?.rev ?? 0) + 1,
        addrGen: person.addrGen,
        given: person.given,
      });
      await peopleCall('card-send', { contactId: person.id, card: b64 });
      await updateContact(person.id, { given: givenOf(card) });
    }
  }, [
    rooms,
    contacts,
    walletId,
    hydrated,
    cards.ready,
    penumbraOn,
    relay,
    addContact,
    updateContact,
  ]);
};
