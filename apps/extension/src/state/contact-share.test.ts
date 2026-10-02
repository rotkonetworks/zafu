import { describe, expect, it, vi } from 'vitest';
import { bytesToHex, decodeContactCard, decodeMemo } from '@repo/wallet/networks/zcash/memo-codec';
import { parseLink, toUri } from '../links/router';
import {
  cardLinkPayload,
  contactCardMemoHex,
  myAddressForContact,
  replyAddress,
  type DeriveAddress,
} from './contact-share';
import { contactDiversifierIndex } from '@repo/wallet/networks/zcash/diversified-address';

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
    const mine = await myAddressForContact('bob-contact-id', { ufvk: ALICE_UFVK }, aliceDerive);
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
    expect(await myAddressForContact('bob-contact-id', {}, derive)).toBeUndefined();
    expect(
      await myAddressForContact('bob-contact-id', { ufvk: 'zxviews1old' }, derive),
    ).toBeUndefined();
    expect(derive).not.toHaveBeenCalled();
  });

  it('refuses when the derivation fails', async () => {
    const broken: DeriveAddress = () => {
      throw new Error('wasm');
    };
    expect(
      await myAddressForContact('bob-contact-id', { ufvk: ALICE_UFVK }, broken),
    ).toBeUndefined();
  });

  it('the address is stable per contact and differs between contacts', async () => {
    const a = await myAddressForContact('bob-contact-id', { ufvk: ALICE_UFVK }, aliceDerive);
    const b = await myAddressForContact('bob-contact-id', { ufvk: ALICE_UFVK }, aliceDerive);
    const c = await myAddressForContact('carol-contact-id', { ufvk: ALICE_UFVK }, aliceDerive);
    expect(a).toEqual(b);
    expect(c?.address).not.toBe(a?.address);
  });
});

describe('a hot seed wallet (no viewing key stored)', () => {
  /** the worker's seed derivation, stood in: alice's address at an index */
  const seed = vi.fn(async (index: number) => `u1aliceseedat${index}`);
  const RECEIVE = 'u1aliceseedrotating';

  it('derives the per-contact address from the seed, not the receive address', async () => {
    const mine = await myAddressForContact('bob-contact-id', { ufvk: '', seed });
    const index = await contactDiversifierIndex('bob-contact-id');
    expect(seed).toHaveBeenCalledWith(index);
    expect(mine).toEqual({ address: `u1aliceseedat${index}`, index });
    expect(mine!.address).not.toBe(RECEIVE);
  });

  it('a reply to a saved contact carries that address too', async () => {
    const mine = await myAddressForContact('bob-contact-id', { seed });
    expect(await replyAddress('bob-contact-id', { seed }, RECEIVE)).toBe(mine!.address);
  });

  it('refuses when the worker derivation fails', async () => {
    const broken = async () => {
      throw new Error('worker');
    };
    expect(await myAddressForContact('bob-contact-id', { seed: broken })).toBeUndefined();
  });
});

describe('the reply address', () => {
  it('a saved contact gets your address for them, not the rotating one', async () => {
    const mine = await myAddressForContact('bob-contact-id', { ufvk: ALICE_UFVK }, aliceDerive);
    expect(
      await replyAddress('bob-contact-id', { ufvk: ALICE_UFVK }, 'u1rotating', aliceDerive),
    ).toBe(mine!.address);
  });

  it('anyone else gets the address on screen', async () => {
    expect(await replyAddress(undefined, { ufvk: ALICE_UFVK }, 'u1rotating', aliceDerive)).toBe(
      'u1rotating',
    );
  });
});

describe('a card link', () => {
  it('fits a zafu:contact link and comes back to the same memo', () => {
    const hex = contactCardMemoHex({ senderName: '', myAddress: 'u1' + 'q'.repeat(140) })!;
    const payload = cardLinkPayload(hex);
    expect(parseLink(toUri({ kind: 'contact', card: payload }))).toEqual({
      ok: true,
      intent: { kind: 'contact', card: payload },
    });
    const back = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), c =>
      c.charCodeAt(0),
    );
    const memo = new Uint8Array(512);
    memo.set(back);
    expect(bytesToHex(memo)).toBe(hex);
  });
});
