import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';
import { keyInfoSupportsNetwork } from '../state/keyring/vault-ops';
import type { Contact, ContactRel } from '../state/contacts';
import { contactCardMemoHex, myAddressForContact } from '../state/contact-share';
import {
  deriveRelationshipKeys,
  getZidIndex,
  mintRelationshipIndex,
  myDiscoveryKey,
} from '../state/identity';
import { getDiversifiedAddresses, setDiversifiedAddresses } from '../state/diversified-addresses';
import { PopupPath } from '../routes/popup/paths';
import { useContactAddressSource } from './use-contact-address-source';

const contactNow = (id: string): Contact | undefined => {
  const all = useStore.getState().contacts.contacts;
  return (Array.isArray(all) ? all : []).find(c => c.id === id);
};

/** one mint per person, however many screens ask at once */
const minting = new Map<string, Promise<ContactRel>>();

/** the relationship you give this person: minted once, then kept on them */
const relationshipOf = (
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

/**
 * Your card for one saved contact, as memo hex: your own address for them and
 * your key for them, under no name (a card carries no name until you choose
 * one to share). The address is recorded, keyed by the contact's id, so a
 * payment to it is known to be theirs. Undefined when this wallet has no
 * zcash; the call resolves undefined when no address for them could be made.
 * It never falls back to anyone else's address or to the cross-site key.
 */
export const useMintCard = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const addressSource = useContactAddressSource();
  const canMint = !!keyInfo && keyInfoSupportsNetwork(keyInfo, 'zcash');
  const updateContact = useStore(s => s.contacts.updateContact);

  const mint = useCallback(
    async (contactId: string): Promise<string | undefined> => {
      if (!keyInfo) {
        return undefined;
      }
      const mine = await myAddressForContact(contactId, addressSource());
      if (!mine) {
        return undefined;
      }
      const records = await getDiversifiedAddresses();
      if (!records.some(r => r.diversifierIndex === mine.index)) {
        await setDiversifiedAddresses([
          ...records,
          {
            diversifierIndex: mine.index,
            // the contact's id: a name can change, the id cannot
            sharedWith: contactId,
            address: mine.address,
            sharedAt: Date.now(),
          },
        ]);
      }
      const mnemonic = keyInfo.type === 'mnemonic' ? await getMnemonic(keyInfo.id) : undefined;
      // the relationship you give this person: its inception key is the card's
      // seal, its own KA key opens your pair room; the discovery key rides too
      const rel = mnemonic && (await relationshipOf(contactId, keyInfo.id, updateContact));
      const keys = mnemonic && rel ? deriveRelationshipKeys(mnemonic, rel.gen, rel.j) : undefined;
      const ka = mnemonic && (await myDiscoveryKey(mnemonic));
      return contactCardMemoHex({
        senderName: '',
        myAddress: mine.address,
        zid: keys?.pubkey,
        ka,
        pairKa: keys?.kaPublicKey,
        answers: contactNow(contactId)?.zid,
      });
    },
    [keyInfo, addressSource, getMnemonic, updateContact],
  );

  return canMint ? mint : undefined;
};

/**
 * Send one contact your card by memo: the send form opens with the recipient
 * and the card filled in. Undefined when this wallet cannot; resolves false
 * when the contact has no zcash address or no card could be made.
 */
export const useShareCard = () => {
  const navigate = useNavigate();
  const mint = useMintCard();

  const share = useCallback(
    async (contact: Contact): Promise<boolean> => {
      const to = contact.addresses.find(a => a.network === 'zcash')?.address;
      const hex = to && mint ? await mint(contact.id) : undefined;
      if (!to || !hex) {
        return false;
      }
      navigate(PopupPath.SEND, {
        state: { prefillRecipient: to, prefillMemo: hex, network: 'zcash' },
      });
      return true;
    },
    [mint, navigate],
  );

  return mint ? share : undefined;
};
