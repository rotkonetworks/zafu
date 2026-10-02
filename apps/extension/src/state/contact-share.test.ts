import { describe, expect, it, vi } from 'vitest';
import { decodeContactCard, decodeMemo } from '@repo/wallet/networks/zcash/memo-codec';
import {
  cardSenderName,
  contactCardMemoHex,
  myAddressForContact,
  replyAddress,
  type DeriveAddress,
} from './contact-share';

const ALICE_UFVK = 'uview1alice';
const BOB_ADDRESS = 'u1bobsownaddress';
/** a stand-in for the wasm: alice's address at an index */
const aliceDerive: DeriveAddress = (ufvk, index) => `u1${ufvk.slice(6)}at${index}`;

const decodeHex = (hex: string) => {
  const bytes = new Uint8Array(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  return decodeContactCard(decodeMemo(bytes)!.payload);
};

describe('a card alice shares with bob', () => {
  it('carries alice, and an address of alice that is not bob', async () => {
    const mine = await myAddressForContact('bob-contact-id', ALICE_UFVK, aliceDerive);
    expect(mine).toBeDefined();
    const hex = contactCardMemoHex({ senderName: 'alice', myAddress: mine!.address });
    const card = decodeHex(hex!);
    expect(card?.name).toBe('alice');
    expect(card?.address).toBe(mine!.address);
    expect(card?.address).not.toBe(BOB_ADDRESS);
    expect(card?.address.startsWith('u1alice')).toBe(true);
  });

  it('refuses without a viewing key, and never falls back to bob', async () => {
    const derive = vi.fn(aliceDerive);
    expect(await myAddressForContact('bob-contact-id', undefined, derive)).toBeUndefined();
    expect(await myAddressForContact('bob-contact-id', 'zxviews1old', derive)).toBeUndefined();
    expect(derive).not.toHaveBeenCalled();
  });

  it('refuses when the derivation fails', async () => {
    const broken: DeriveAddress = () => {
      throw new Error('wasm');
    };
    expect(await myAddressForContact('bob-contact-id', ALICE_UFVK, broken)).toBeUndefined();
  });

  it('the address is stable per contact and differs between contacts', async () => {
    const a = await myAddressForContact('bob-contact-id', ALICE_UFVK, aliceDerive);
    const b = await myAddressForContact('bob-contact-id', ALICE_UFVK, aliceDerive);
    const c = await myAddressForContact('carol-contact-id', ALICE_UFVK, aliceDerive);
    expect(a).toEqual(b);
    expect(c?.address).not.toBe(a?.address);
  });

  it('a default wallet name goes out as no name', () => {
    expect(cardSenderName('Wallet 1')).toBe('');
    expect(cardSenderName(' alice ')).toBe('alice');
    expect(cardSenderName(undefined)).toBe('');
  });
});

describe('the reply address', () => {
  it('a saved contact gets your address for them, not the rotating one', async () => {
    const mine = await myAddressForContact('bob-contact-id', ALICE_UFVK, aliceDerive);
    expect(await replyAddress('bob-contact-id', ALICE_UFVK, 'u1rotating', aliceDerive)).toBe(
      mine!.address,
    );
  });

  it('anyone else gets the address on screen', async () => {
    expect(await replyAddress(undefined, ALICE_UFVK, 'u1rotating', aliceDerive)).toBe('u1rotating');
  });
});
