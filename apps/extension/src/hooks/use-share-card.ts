import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DiversifiedAddressRecord } from '@repo/wallet/networks/zcash/diversified-address';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';
import { keyInfoSupportsNetwork } from '../state/keyring/vault-ops';
import type { Contact } from '../state/contacts';
import { contactCardMemoHex, myAddressForContact } from '../state/contact-share';
import { deriveZidForContact } from '../state/identity';
import { getDiversifiedAddresses, setDiversifiedAddresses } from '../state/diversified-addresses';
import { PopupPath } from '../routes/popup/paths';
import { useContactAddressSource } from './use-contact-address-source';

/**
 * Send one contact your card by memo: your own address for them and your
 * key for them, under no name (a card carries no name until you choose one to
 * share). Opens the send form with the recipient and the card filled in.
 * Undefined when this wallet cannot (no zcash, or the contact has no zcash
 * address). Resolves false when no address for them could be made; it never
 * falls back to anyone else's address or to the cross-site key.
 */
export const useShareCard = () => {
  const navigate = useNavigate();
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const addressSource = useContactAddressSource();
  const canShare = !!keyInfo && keyInfoSupportsNetwork(keyInfo, 'zcash');

  const share = useCallback(
    async (contact: Contact): Promise<boolean> => {
      const to = contact.addresses.find(a => a.network === 'zcash')?.address;
      if (!keyInfo || !to) {
        return false;
      }
      const mine = await myAddressForContact(contact.id, addressSource());
      if (!mine) {
        return false;
      }
      const records: DiversifiedAddressRecord[] = await getDiversifiedAddresses();
      if (!records.some(r => r.diversifierIndex === mine.index)) {
        await setDiversifiedAddresses([
          ...records,
          {
            diversifierIndex: mine.index,
            sharedWith: contact.name || contact.id,
            address: mine.address,
            sharedAt: Date.now(),
          },
        ]);
      }
      let zid: string | undefined;
      if (keyInfo.type === 'mnemonic') {
        zid = deriveZidForContact(await getMnemonic(keyInfo.id), 'default', contact.id).publicKey;
      }
      const hex = contactCardMemoHex({ senderName: '', myAddress: mine.address, zid });
      if (!hex) {
        return false;
      }
      navigate(PopupPath.SEND, {
        state: { prefillRecipient: to, prefillMemo: hex, network: 'zcash' },
      });
      return true;
    },
    [keyInfo, addressSource, getMnemonic, navigate],
  );

  return canShare ? share : undefined;
};
