import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let contacts: unknown = [];
/** what the store holds now, when a test wants it to differ from what a render saw */
let live: unknown;
let hydrated = true;
let rooms: unknown[] = [];
const addContact = vi.fn(async () => ({}));
const updateContact = vi.fn(async () => undefined);
const peopleCall = vi.fn(async () => ({}));
const store = {
  keyRing: { selectedKeyInfo: { id: 'w', type: 'mnemonic' }, enabledNetworks: ['zcash'] },
  contacts: {
    get contacts() {
      return contacts;
    },
    addContact,
    updateContact,
  },
};
vi.mock('../state', () => ({
  useStore: Object.assign(
    (selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store),
    {
      getState: () =>
        live ? { ...store, contacts: { ...store.contacts, contacts: live } } : store,
    },
  ),
}));
vi.mock('../state/keyring', () => ({
  selectEffectiveKeyInfo: (s: typeof store) => s.keyRing.selectedKeyInfo,
  selectEnabledNetworks: (s: typeof store) => s.keyRing.enabledNetworks,
  selectGetMnemonic: () => vi.fn(),
}));
vi.mock('../hooks/use-contact-address-source', () => ({
  useContactAddressSource: () => () => ({}),
}));
vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: { get: async () => undefined } }));
vi.mock('../state/encrypted-storage', () => ({
  whenHydrated: () => (hydrated ? Promise.resolve() : new Promise(() => undefined)),
}));
vi.mock('./client', () => ({
  peopleCall: (...a: unknown[]) => peopleCall(...(a as [])),
  useMyRooms: () => rooms,
}));

import {
  CARD_DEFAULT_RELAY,
  Cap,
  answersOf,
  cardB64,
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { contactFromAnswer, givenOf, isStale, useCardSync } from './my-card';

const seed = new Uint8Array(32).fill(1);
const key = bytesToHex(ed25519.getPublicKey(seed));
const theirSeed = new Uint8Array(32).fill(2);
const theirKey = bytesToHex(ed25519.getPublicKey(theirSeed));
const base: CardV2 = {
  kind: 'card',
  revision: 0,
  key,
  pairKa: 'ab'.repeat(32),
  zcash: '11'.repeat(43),
  relay: CARD_DEFAULT_RELAY,
  caps: Cap.chat | Cap.mailbox,
  created: 1,
};
const mine = cardB64(signCardV2(base, seed));
const answer = cardB64(
  signCardV2(
    { ...base, kind: 'answer', key: theirKey, answers: answersOf(key), name: 'ken' },
    theirSeed,
  ),
);
const answeredRoom = {
  id: `c:${key}`,
  walletId: 'w',
  kind: 'card',
  signer: { gen: 0, j: 4 },
  joined: false,
  card: {
    bytes: mine,
    mine: true,
    contactId: 'ken-id',
    shown: 0,
    state: 'answered',
    answer,
    via: 'relay',
  },
};

describe('your card for someone', () => {
  it('is stale when it says something else now, or was never given (a v1 contact)', () => {
    const given = givenOf(base);
    const now = {
      zcash: base.zcash,
      penumbraOn: false,
      relay: CARD_DEFAULT_RELAY,
      caps: base.caps,
    };
    expect(isStale(given, now)).toBe(false);
    expect(isStale(undefined, now)).toBe(true);
    expect(isStale(given, { ...now, zcash: '22'.repeat(43) })).toBe(true);
    expect(isStale(given, { ...now, relay: 'https://relay.example.org' })).toBe(true);
    expect(isStale(given, { ...now, penumbraOn: true })).toBe(true);
  });

  it('an answer becomes the person, under the id their address was made for', () => {
    expect(contactFromAnswer(answeredRoom as never, 'w')).toMatchObject({
      id: 'ken-id',
      name: 'ken',
      zid: theirKey,
      rel: { walletId: 'w', gen: 0, j: 4 },
      cardV2: answer,
      source: 'link',
      given: { rev: 0, relay: CARD_DEFAULT_RELAY },
    });
  });
});

describe('useCardSync', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllMocks();
  });
  const Probe = () => {
    useCardSync();
    return null;
  };

  it('saves the person an answer names', async () => {
    contacts = [];
    rooms = [answeredRoom];
    await act(async () => root.render(createElement(Probe)));
    expect(addContact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ken-id', zid: theirKey }),
    );
  });

  it('never adds a person the store already holds, whatever this render saw', async () => {
    contacts = [];
    live = [{ id: 'ken-id', name: 'bob', addresses: [], createdAt: 0 }];
    rooms = [answeredRoom];
    await act(async () => root.render(createElement(Probe)));
    expect(addContact).not.toHaveBeenCalled();
    live = undefined;
  });

  it('writes nothing before this window read its contacts', async () => {
    hydrated = false;
    contacts = [];
    rooms = [answeredRoom];
    await act(async () => root.render(createElement(Probe)));
    expect(addContact).not.toHaveBeenCalled();
    hydrated = true;
  });

  it('leaves contacts sealed at rest alone: no write, no throw', async () => {
    contacts = { encrypted: { c: 'x' } };
    rooms = [
      answeredRoom,
      {
        id: 'p:x',
        walletId: 'w',
        kind: 'pair',
        joined: true,
        signer: { gen: 0, j: 1 },
        pair: { personId: 'x', v2: { latest: answer, confirmDue: true } },
      },
    ];
    await act(async () => root.render(createElement(Probe)));
    expect(addContact).not.toHaveBeenCalled();
    expect(updateContact).not.toHaveBeenCalled();
    expect(peopleCall).not.toHaveBeenCalled();
  });

  it('keeps their newest card on the contact and sends a pending confirmation', async () => {
    contacts = [{ id: 'x', name: 'ken', addresses: [], createdAt: 0 }];
    rooms = [
      {
        id: 'p:x',
        walletId: 'w',
        kind: 'pair',
        joined: true,
        signer: { gen: 0, j: 1 },
        pair: { personId: 'x', v2: { latest: answer, confirmDue: true } },
      },
    ];
    await act(async () => root.render(createElement(Probe)));
    expect(updateContact).toHaveBeenCalledWith('x', expect.objectContaining({ cardV2: answer }));
    expect(peopleCall).toHaveBeenCalledWith('card-confirm', { contactId: 'x' });
  });
});
