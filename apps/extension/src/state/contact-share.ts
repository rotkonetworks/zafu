/**
 * What you hand one contact: your own per-contact zcash address, and the card
 * that carries it under your name.
 */

import { bytesToHex, encodeContactCard } from '@repo/wallet/networks/zcash/memo-codec';
import { contactDiversifierIndex } from '@repo/wallet/networks/zcash/diversified-address';

/** (ufvk, diversifier index) -> address */
export type DeriveAddress = (ufvk: string, index: number) => string | Promise<string>;

/** the wasm derivation; this realm's module instance must be initialised first */
export const wasmDeriveAddress: DeriveAddress = async (ufvk, index) => {
  const wasm = (await import('@repo/zcash-wasm')) as unknown as {
    default?: () => Promise<unknown>;
    address_from_ufvk: (ufvk: string, index: number) => string;
  };
  if (typeof wasm.default === 'function') {
    await wasm.default();
  }
  return wasm.address_from_ufvk(ufvk, index);
};

/**
 * Your address for this one contact, from your own viewing key. Undefined when
 * there is no viewing key or the derivation fails - never anyone else's address.
 */
export const myAddressForContact = async (
  contactId: string,
  ufvk: string | undefined,
  derive: DeriveAddress = wasmDeriveAddress,
): Promise<{ address: string; index: number } | undefined> => {
  if (!ufvk?.startsWith('uview')) {
    return undefined;
  }
  try {
    const index = await contactDiversifierIndex(contactId);
    const address = await derive(ufvk, index);
    return address ? { address, index } : undefined;
  } catch (e) {
    console.warn('[contact-share] could not derive the contact address:', e);
    return undefined;
  }
};

/** a contact card memo, as hex, carrying the sender's name and address */
export const contactCardMemoHex = (card: {
  senderName: string;
  myAddress: string;
  zid?: string;
}): string | undefined => {
  const memos = encodeContactCard({
    name: card.senderName,
    address: card.myAddress,
    flags: 0,
    zid: card.zid,
  });
  return memos[0] && bytesToHex(memos[0]);
};

/**
 * The `reply:` address for a message: a saved contact gets your own address
 * for them, anyone else the address on screen now.
 */
export const replyAddress = async (
  contactId: string | undefined,
  ufvk: string | undefined,
  current: string | undefined,
  derive: DeriveAddress = wasmDeriveAddress,
): Promise<string | undefined> =>
  (contactId && (await myAddressForContact(contactId, ufvk, derive))?.address) || current;
