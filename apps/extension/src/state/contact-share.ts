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

/** diversifier index -> your address there, derived in the zcash worker from the seed */
export type SeedDerive = (index: number) => Promise<string>;

/** where your own addresses come from: a viewing key, or (hot wallets) the seed */
export interface AddressSource {
  ufvk?: string;
  seed?: SeedDerive;
}

/**
 * Your address for this one contact, from your viewing key or your seed.
 * Undefined when the wallet has neither or the derivation fails - never anyone
 * else's address, and never the rotating receive address.
 */
export const myAddressForContact = async (
  contactId: string,
  source: AddressSource,
  derive: DeriveAddress = wasmDeriveAddress,
): Promise<{ address: string; index: number } | undefined> => {
  const ufvk = source.ufvk?.startsWith('uview') ? source.ufvk : undefined;
  if (!ufvk && !source.seed) {
    return undefined;
  }
  try {
    const index = await contactDiversifierIndex(contactId);
    const address = ufvk ? await derive(ufvk, index) : await source.seed!(index);
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
  source: AddressSource,
  current: string | undefined,
  derive: DeriveAddress = wasmDeriveAddress,
): Promise<string | undefined> =>
  (contactId && (await myAddressForContact(contactId, source, derive))?.address) || current;

/**
 * A card memo as the `#` part of a card link (`zafu:contact#...`): the memo
 * bytes without their zero padding, base64url. The reader pads it back to 512.
 */
export const cardLinkPayload = (memoHex: string): string => {
  const bytes = (memoHex.match(/../g) ?? []).map(b => parseInt(b, 16));
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end--;
  }
  return btoa(String.fromCharCode(...bytes.slice(0, end)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};
