/** the relationship (xid-rel-v1) you give one saved person, minted once */

import { useStore } from '../state';
import type { Contact, ContactRel } from '../state/contacts';
import { getZidIndex, mintRelationshipIndex } from '../state/identity';

export const contactNow = (id: string): Contact | undefined => {
  const all = useStore.getState().contacts.contacts;
  return (Array.isArray(all) ? all : []).find(c => c.id === id);
};

/** one mint per person, however many screens ask at once */
const minting = new Map<string, Promise<ContactRel>>();

/** the relationship you give this person: minted once, then kept on them */
export const relationshipOf = (
  contactId: string,
  walletId: string,
  updateContact: (id: string, u: { rel: ContactRel }) => Promise<void>,
): Promise<ContactRel> => {
  const have = contactNow(contactId)?.rel;
  if (have?.walletId === walletId) {
    return Promise.resolve(have);
  }
  const key = `${walletId}/${contactId}`;
  const running = minting.get(key);
  if (running) {
    return running;
  }
  const made = (async () => {
    const gen = await getZidIndex(walletId);
    const rel = { walletId, gen, j: await mintRelationshipIndex(walletId, gen) };
    await updateContact(contactId, { rel });
    return rel;
  })().finally(() => minting.delete(key));
  minting.set(key, made);
  return made;
};
