import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALICE = 'u1' + 'a'.repeat(140);
const navigate = vi.fn();
let params = new URLSearchParams();
let saved: { id: string; name: string } | undefined;
let records: { address: string }[] = [];
const addContact = vi.fn(async ({ name, id, zid }: { name: string; id?: string; zid?: string }) => {
  // the person is in the store from now on, as the real slice does
  contacts = [...contacts, { id: id ?? 'c1', name, zid }];
  return { id: id ?? 'c1', name };
});
const addAddress = vi.fn(async () => ({}));
let contacts: { id: string; name: string; zid?: string }[] = [];
let rooms: { id: string; card?: { mine: boolean } }[] = [];
let peek: { closed?: boolean } = {};
let relayDown = false;
let relayKnown = true;
// set below, once the card helpers are imported
let answerCard: () => { b64: string; card: unknown } = () => ({ b64: '', card: {} });
const store = {
  keyRing: {
    keyInfos: [],
    selectedKeyInfo: undefined,
    activeNetwork: 'zcash',
    getMnemonic: vi.fn(),
  },
  contacts: {
    get contacts() {
      return contacts;
    },
    findByAddress: () => (saved ? { contact: saved } : undefined),
    addContact,
    addAddress,
  },
};

vi.mock('../../../state', () => ({
  useStore: (selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store),
}));
vi.mock('../../../state/diversified-addresses', () => ({
  getDiversifiedAddresses: async () => records,
}));
vi.mock('../../../people/client', () => ({
  peopleCall: vi.fn(async () => peek),
  peopleAsk: vi.fn(async () => {
    if (relayDown) {
      throw new Error('the relay is not answering');
    }
    return {};
  }),
  useMyRooms: () => rooms,
}));
vi.mock('../../../people/my-card', () => ({
  useMyCards: () => ({
    ready: true,
    newRel: async () => ({ walletId: 'w', gen: 0, j: 2 }),
    answer: async () => answerCard(),
  }),
  addressesOf: () => [],
  givenOf: () => ({}),
}));
const allowRelay = vi.fn(async () => true);
vi.mock('../../../people/use-invites', () => ({
  allowRelay: (r: string) => allowRelay(r),
  knownRelay: vi.fn(async () => relayKnown),
}));
vi.mock('../../../utils/navigate', () => ({ useBackNav: () => vi.fn() }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [params],
  useLocation: () => ({ key: 'x' }),
}));

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { CARD_DEFAULT_RELAY, Cap, cardB64, signCardV2 } from '@repo/wallet/networks/zcash/card-v2';
import { cardLinkPayload, contactCardMemoHex } from '../../../state/contact-share';
import { CardPage, cardState, offers } from './card';

const seed = new Uint8Array(32).fill(5);
const KEN = bytesToHex(ed25519.getPublicKey(seed));
const kenCard = {
  kind: 'card' as const,
  revision: 0,
  key: KEN,
  pairKa: 'ab'.repeat(32),
  zcash: '11'.repeat(43),
  relay: CARD_DEFAULT_RELAY,
  caps: Cap.chat | Cap.mailbox,
  name: 'ken',
  created: 29_000_000,
};
const v2Link = (c = kenCard) => cardB64(signCardV2(c, seed));
answerCard = () => ({ b64: v2Link({ ...kenCard, kind: 'answer' as never }), card: kenCard });

const linkFor = (address: string, name = '') =>
  cardLinkPayload(
    contactCardMemoHex({ senderName: name, myAddress: address, zid: 'cd'.repeat(32) })!,
  );

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  saved = undefined;
  records = [];
  contacts = [];
  rooms = [];
  peek = {};
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const render = async (card: string) => {
  params = new URLSearchParams({ card, via: 'scanned' });
  await act(async () => root.render(createElement(CardPage)));
};
const text = () => container.textContent ?? '';

describe('cardState', () => {
  const card = { version: 1, flags: 0, name: '', address: ALICE };
  it('puts your own card before a saved person, and a saved person before someone new', () => {
    expect(cardState(undefined, undefined, false).kind).toBe('unreadable');
    expect(cardState(card, { id: 'x', name: 'alice' }, true).kind).toBe('mine');
    expect(cardState(card, { id: 'x', name: 'alice' }, false).kind).toBe('saved');
    expect(cardState(card, undefined, false).kind).toBe('new');
  });
});

describe('a v2 card', () => {
  it('shows who it is, that the signature holds, and what they offer', async () => {
    await render(v2Link());
    expect(text()).toContain('add ken');
    expect(text()).toContain('the name in their card');
    expect(text()).toContain('unchanged since signed');
    expect(text()).toContain('check it when you meet');
    expect(text()).toContain('came froma qr · just now');
    expect(offers(kenCard)).toEqual(['chat', 'zcash']);
  });

  it('refuses a card changed after it was signed, and saves nothing', async () => {
    const bytes = signCardV2(kenCard, seed);
    bytes[10]! ^= 1;
    await render(cardB64(bytes));
    expect(text()).toContain('something in it changed after it was signed');
    expect(text()).toContain('saved nothing');
  });

  it('says a card its maker cancelled was cancelled', async () => {
    peek = { closed: true };
    await render(v2Link());
    expect(text()).toContain('it was cancelled by the person who made it');
  });

  it('knows your own card, and someone already saved', async () => {
    rooms = [{ id: `c:${KEN}`, card: { mine: true } }];
    await render(v2Link());
    expect(text()).toContain('this is your own card');
    act(() => root.unmount());
    root = createRoot(container);
    rooms = [];
    contacts = [{ id: 'k', name: 'kenji', zid: KEN }];
    await render(v2Link());
    expect(text()).toContain('kenji is already in your people');
  });
});

describe('saving a v2 card', () => {
  it('when the relay does not answer, the same screen offers the memo, not "already saved"', async () => {
    relayDown = true;
    await render(v2Link());
    const input = container.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'ken');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'save')!;
    await act(async () => save.click());
    await act(async () => root.render(createElement(CardPage)));
    expect(addContact).toHaveBeenCalled();
    expect(text()).toContain('the relay is not answering');
    expect(text()).toContain('answer by memo');
    expect(text()).not.toContain('already in your people');
    relayDown = false;
  });
});

describe('a card on a relay zafu does not know', () => {
  const typeName = async () => {
    const input = container.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'ken');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const button = (name: string) =>
    [...document.body.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('names the host, and asks before anything is allowed or saved, even with people on', async () => {
    relayKnown = false;
    await render(v2Link({ ...kenCard, relay: 'https://tracker.example' }));
    expect(text()).toContain('tracker.example · new to zafu');
    await typeName();
    await act(async () => button('save').click());
    expect(document.body.textContent).toContain('use this relay?');
    expect(document.body.textContent).toContain('tracker.example is a relay zafu does not know');
    await act(async () => button('not now').click());
    expect(allowRelay).not.toHaveBeenCalled();
    expect(addContact).not.toHaveBeenCalled();
    // a yes allows that host, then saves
    await act(async () => button('save').click());
    await act(async () => button('allow').click());
    expect(allowRelay).toHaveBeenCalledWith('https://tracker.example');
    expect(addContact).toHaveBeenCalled();
    relayKnown = true;
  });

  it('a card naming plain http off this computer does not read', async () => {
    expect(() => v2Link({ ...kenCard, relay: 'http://tracker.example' })).toThrow();
  });
});

describe('the card review (v1)', () => {
  it('shows someone new as not signed, with no name of their own', async () => {
    await render(linkFor(ALICE));
    expect(text()).toContain('someone');
    expect(text()).toContain('an older card · not signed');
    expect(text()).toContain('link scanned');
    expect(text()).not.toMatch(/verified|checked in person/);
  });

  it('says plainly when it is not a card', async () => {
    await render('A'.repeat(40));
    expect(text()).toContain('this is not a zafu card');
  });

  it('knows your own card', async () => {
    records = [{ address: ALICE }];
    await render(linkFor(ALICE));
    expect(text()).toContain('this is your own card');
  });

  it('opens someone already saved instead of saving them twice', async () => {
    saved = { id: 'bob-id', name: 'bob' };
    await render(linkFor(ALICE));
    expect(text()).toContain('bob is already in your people');
  });
});
