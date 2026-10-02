/**
 * What you hand one contact: your own per-contact zcash address, and the card
 * that carries it under your name.
 */

import {
  bytesToHex,
  decodeContactCard,
  decodeMemo,
  encodeContactCard,
  MemoType,
  type ContactCard,
} from '@repo/wallet/networks/zcash/memo-codec';
import { contactDiversifierIndex } from '@repo/wallet/networks/zcash/diversified-address';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';

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
  // the wasm answers in its debug form (`u1orchard:<hex>`); a card must carry
  // a real unified address
  return fixOrchardAddress(wasm.address_from_ufvk(ufvk, index), !ufvk.startsWith('uviewtest'));
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

/**
 * a contact card memo, as hex, carrying the sender's name and address, and
 * (`ka`) the contact key-agreement key that lets the two of you find each
 * other on sites with private contact discovery
 */
export const contactCardMemoHex = (card: {
  senderName: string;
  myAddress: string;
  zid?: string;
  ka?: string;
}): string | undefined => {
  const memos = encodeContactCard({
    name: card.senderName,
    address: card.myAddress,
    flags: 0,
    zid: card.zid,
    ka: card.ka,
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

/** a zcash unified address in its bech32 shape (the checksum is the wasm's to check) */
const UA = /^u1[02-9ac-hj-np-z]{100,}$/;

/**
 * The card inside a card link's `#` part, or undefined when it is not one: a
 * single contact-card memo carrying a unified address. A v1 card is not
 * signed, so everything in it is the sender's word until you meet.
 */
export const readCardPayload = (payload: string): ContactCard | undefined => {
  try {
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), c =>
      c.charCodeAt(0),
    );
    if (bytes.length > 512) {
      return undefined;
    }
    const memo = new Uint8Array(512);
    memo.set(bytes);
    const parsed = decodeMemo(memo);
    const card = parsed?.type === MemoType.ContactCard ? decodeContactCard(parsed.payload) : null;
    return card && UA.test(card.address) ? card : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The discovery key a card carries, in the shape a contact stores it. Only
 * x25519-v1 exists today; a card without the key gives an address-only
 * person for discovery.
 */
export const cardDiscoveryKey = (
  card: Pick<ContactCard, 'ka'>,
): { suite: 'x25519-v1'; publicKey: string } | undefined =>
  card.ka && /^[0-9a-f]{64}$/.test(card.ka)
    ? { suite: 'x25519-v1', publicKey: card.ka }
    : undefined;
