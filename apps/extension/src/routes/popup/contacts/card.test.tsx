import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALICE = 'u1' + 'a'.repeat(140);
const navigate = vi.fn();
let params = new URLSearchParams();
let saved: { id: string; name: string } | undefined;
let records: { address: string }[] = [];
const addContact = vi.fn(async ({ name }: { name: string }) => ({ id: 'c1', name }));
const addAddress = vi.fn(async () => ({}));
const store = {
  keyRing: {
    keyInfos: [],
    selectedKeyInfo: undefined,
    activeNetwork: 'zcash',
    getMnemonic: vi.fn(),
  },
  contacts: {
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
vi.mock('../../../hooks/use-share-card', () => ({ useMintCard: () => async () => undefined }));
vi.mock('../../../components/qr-code', () => ({ QrCode: () => null }));
vi.mock('../../../people/client', () => ({ peopleCall: vi.fn(async () => undefined) }));
vi.mock('../../../utils/navigate', () => ({ useBackNav: () => vi.fn() }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [params],
  useLocation: () => ({ key: 'x' }),
}));

import { cardLinkPayload, contactCardMemoHex } from '../../../state/contact-share';
import { CardPage, cardState } from './card';

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

describe('the card review', () => {
  it('shows someone new as not checked, with no name of their own', async () => {
    await render(linkFor(ALICE));
    expect(text()).toContain('someone');
    expect(text()).toContain('a card · not checked yet');
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
