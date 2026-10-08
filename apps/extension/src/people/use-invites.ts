/**
 * The screens' half of the memo door: answer an invite that came in a memo,
 * and put one in the first memo you send someone who has no card from you.
 */

import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';
import { deriveRelationshipKeys, getZidIndex, mintRelationshipIndex } from '../state/identity';
import { cardLinkPayload, contactCardMemoHex, myAddressForContact } from '../state/contact-share';
import type { Contact } from '../state/contacts';
import { relationshipOf } from '../hooks/relationship';
import { useContactAddressSource } from '../hooks/use-contact-address-source';
import { cardRelayOk } from '@repo/wallet/networks/zcash/card-v2';
import { requestEgressOptIn } from '../net/egress-opt-in';
import {
  DEFAULT_PEOPLE_RELAY,
  PEOPLE_RELAY,
  PEOPLE_RELAY_KEY,
  defaultPeopleRelay,
  peopleRelays,
  relayBase,
  type PeopleRelaySetting,
} from '../config/people-relay';
import { PopupPath, groupPath, threadPath } from '../routes/popup/paths';
import { peopleAsk, peopleCall, peopleSay, useMyRooms } from './client';
import { encodeMemoInvite, PENUMBRA_MEMO_TEXT_BYTES, ZCASH_MEMO_BYTES } from './memo-door';
import { pairId } from './protocol';
import type { PairCard, StoredInvite } from './vault';

const readRelaySetting = async (): Promise<PeopleRelaySetting | undefined> =>
  (await chrome.storage.local.get(PEOPLE_RELAY_KEY))[PEOPLE_RELAY_KEY] as
    | PeopleRelaySetting
    | undefined;

/** is this relay one zafu already talks to for people (the default, or one you allowed) */
export const knownRelay = async (relay: string): Promise<boolean> =>
  peopleRelays(await readRelaySetting()).includes(
    relay ? (relayBase(relay) ?? relay) : DEFAULT_PEOPLE_RELAY,
  );

/**
 * The person said yes to this relay, shown by its host (people/relay-ask, or
 * a relay they typed): add it, then turn people-relay on. Plain http is only
 * for a relay on this computer.
 */
export const allowRelay = async (relay: string): Promise<boolean> => {
  const base = relayBase(relay);
  if (!base || !cardRelayOk(base)) {
    return false;
  }
  const s = (await readRelaySetting()) ?? {};
  if (!peopleRelays(s).includes(base)) {
    await chrome.storage.local.set({
      [PEOPLE_RELAY_KEY]: { ...s, hosts: [...(s.hosts ?? []), base] },
    });
  }
  return requestEgressOptIn(PEOPLE_RELAY);
};

const randomSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(
    '',
  );

const fits = (text: string, network: 'zcash' | 'penumbra') =>
  new TextEncoder().encode(text).length <=
  (network === 'zcash' ? ZCASH_MEMO_BYTES : PENUMBRA_MEMO_TEXT_BYTES);

/** accept or decline one invite; the relay is asked for (and an unknown one allowed) by the caller */
export const useAnswerInvite = () => {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const addressSource = useContactAddressSource();
  const addContact = useStore(s => s.contacts.addContact);

  const accept = useCallback(
    async (inv: StoredInvite) => {
      if (!inv.read.ok || !keyInfo || keyInfo.type !== 'mnemonic') {
        return;
      }
      const i = inv.read.invite;
      if (i.kind === 'code') {
        const { code, relay } = await peopleAsk<{ code: string; relay: string }>('invite-accept', {
          id: inv.id,
        });
        navigate(`${PopupPath.INBOX_JOIN}?${new URLSearchParams({ code, relay, via: 'typed' })}`);
        return;
      }
      if (i.kind === 'group') {
        const { id } = await peopleAsk<{ id: string }>('invite-accept', { id: inv.id });
        navigate(groupPath(id.slice(2)));
        return;
      }
      const address = i.address || inv.from || '';
      // one write: a quick second one can lose to the store re-reading the first
      const gen = await getZidIndex(keyInfo.id);
      const rel = { walletId: keyInfo.id, gen, j: await mintRelationshipIndex(keyInfo.id, gen) };
      const contact = await addContact({
        name: i.name || 'someone',
        zid: i.inception,
        pairKa: i.pairKa,
        rel,
        addresses: address ? [{ network: inv.network, address }] : [],
      });
      const keys = deriveRelationshipKeys(await getMnemonic(keyInfo.id), rel.gen, rel.j);
      const mine = await myAddressForContact(contact.id, addressSource());
      const hex = contactCardMemoHex({
        senderName: '',
        myAddress: mine?.address ?? '',
        zid: keys.pubkey,
        pairKa: keys.kaPublicKey,
        answers: i.inception,
      });
      await peopleAsk('invite-accept', {
        id: inv.id,
        contactId: contact.id,
        card: hex ? cardLinkPayload(hex) : '',
      });
      navigate(address ? threadPath(address.toLowerCase()) : PopupPath.INBOX);
    },
    [keyInfo, getMnemonic, addressSource, addContact, navigate],
  );

  const decline = useCallback(
    (inv: StoredInvite) => peopleCall('invite-decline', { id: inv.id }),
    [],
  );

  return { accept, decline };
};

/**
 * The first memo to someone who has no card from you carries an invite to
 * chat: your card for them, a fresh pair-room secret, and the relay you
 * chose for them. The memo is end-to-end encrypted to them already.
 * Resolves the memo to send; text that does not fit beside the invite is
 * said in the new room instead, where they read it once they accept.
 */
export const useMemoInvite = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const addressSource = useContactAddressSource();
  const updateContact = useStore(s => s.contacts.updateContact);

  return useCallback(
    async (contact: Contact, text: string, network: 'zcash' | 'penumbra' = 'zcash') => {
      if (!keyInfo || keyInfo.type !== 'mnemonic') {
        return undefined;
      }
      const rel = await relationshipOf(contact.id, keyInfo.id, updateContact);
      const keys = deriveRelationshipKeys(await getMnemonic(keyInfo.id), rel.gen, rel.j);
      const mine =
        network === 'zcash' ? await myAddressForContact(contact.id, addressSource()) : undefined;
      // '' is the built-in relay; your own default or theirs travels with the invite
      const chosen = contact.relay || defaultPeopleRelay(await readRelaySetting());
      const relay = chosen === DEFAULT_PEOPLE_RELAY ? '' : chosen;
      const secret = randomSecret();
      const line = encodeMemoInvite(
        {
          kind: 'pair',
          secret,
          inception: keys.pubkey,
          pairKa: keys.kaPublicKey,
          name: '',
          address: mine?.address ?? '',
          relay,
        },
        network === 'zcash' ? ZCASH_MEMO_BYTES : PENUMBRA_MEMO_TEXT_BYTES,
      );
      await peopleCall('invite-open', { contactId: contact.id, secret, relay });
      // a space, not a line break: the send form's memo field is one line
      const both = text ? `${text} ${line}` : line;
      if (fits(both, network)) {
        return both;
      }
      void peopleSay(pairId(contact.id), text).catch(() => undefined);
      return line;
    },
    [keyInfo, getMnemonic, addressSource, updateContact],
  );
};

/**
 * A memo answer you confirmed (or one carrying the key you already hold for
 * them) put the other side's card on the pair room; keep it on the contact,
 * so the thread knows you now hold each other's cards. This only fills what
 * the contact lacks: a zid or pair key they already have is never replaced
 * here. Replacing one is `useChooseAnswer`, after you say so.
 */
export const usePairCards = (): void => {
  const rooms = useMyRooms();
  const contacts = useStore(s => s.contacts.contacts);
  const updateContact = useStore(s => s.contacts.updateContact);
  useEffect(() => {
    for (const r of rooms) {
      const card = r.pair?.card;
      const c =
        card && (Array.isArray(contacts) ? contacts : []).find(x => x.id === r.pair!.personId);
      if (!card || !c) {
        continue;
      }
      const fill = {
        ...(!c.zid ? { zid: card.zid } : {}),
        ...(!c.pairKa && (!c.zid || c.zid === card.zid) ? { pairKa: card.pairKa } : {}),
      };
      if (Object.keys(fill).length) {
        void updateContact(c.id, fill);
      }
    }
  }, [rooms, contacts, updateContact]);
};

/**
 * You looked at an answer to your memo invite and said it is them: it
 * becomes the person in the pair room and its keys go on the contact, in
 * place of any they had. The only path that replaces a contact's keys.
 */
export const useChooseAnswer = () => {
  const updateContact = useStore(s => s.contacts.updateContact);
  return useCallback(
    async (contactId: string, card: PairCard) => {
      await peopleCall('pair-choose', { contactId, zid: card.zid });
      await updateContact(contactId, { zid: card.zid, pairKa: card.pairKa });
    },
    [updateContact],
  );
};
