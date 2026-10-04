import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message } from '../../../state/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The thread only needs the store, the codec and its own pure helpers; the
// route module's other imports (send, wasm, workers) are replaced.
const ALICE = 'u1alice0000000000000000000000000000000000000000';
const navigate = vi.fn();
const addContact = vi.fn(async () => ({ id: 'c1' }));
const msg = (over: Partial<Message>): Message => ({
  id: over.txId ?? 'id',
  network: 'zcash',
  recipientAddress: '',
  senderAddress: ALICE,
  content: '',
  txId: 't',
  blockHeight: 1,
  timestamp: Date.now(),
  direction: 'received',
  read: true,
  ...over,
});
const store = {
  messages: {
    messages: [] as Message[],
    markRead: vi.fn(async () => undefined),
  },
  contacts: {
    findByAddress: (_a: string): unknown => undefined,
    addContact,
    addAddress: vi.fn(async () => ({})),
  },
};

vi.mock('../../../state', () => ({
  useStore: (selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store),
}));
vi.mock('../../../state/keyring', () => ({
  selectEffectiveKeyInfo: () => ({ id: 'w', type: 'mnemonic' }),
}));
vi.mock('../../../state/keyring/vault-ops', () => ({ keyInfoSupportsNetwork: () => true }));
vi.mock('../../../state/contact-share', () => ({ replyAddress: async () => 'u1mine' }));
vi.mock('../../../hooks/use-contact-address-source', () => ({
  useContactAddressSource: () => () => ({}),
}));
vi.mock('../../../hooks/use-address', () => ({ useActiveAddress: () => ({}) }));
// the people relay is the worker's: nobody here holds a card, so it stays out
vi.mock('../../../people/client', () => ({
  peopleCall: vi.fn(async () => undefined),
  peopleSay: vi.fn(async () => undefined),
  useMyRooms: () => [],
  useThread: () => undefined,
  useWatchRoom: () => undefined,
}));
vi.mock('../../../people/use-invites', () => ({
  allowRelay: vi.fn(),
  useMemoInvite: () => vi.fn(async () => undefined),
  usePairCards: () => undefined,
}));
vi.mock('../../../people/relay-slot', () => ({ RelaySlot: () => null }));
vi.mock('../../../people/my-card', () => ({ useCardSync: () => undefined, addressesOf: () => [] }));
// shared wallets and deals ride the pair room, which nobody here has
vi.mock('../../../people/use-frost-room', () => ({
  useFrostRoom: () => ({ payments: [], kept: {} }),
}));
vi.mock('../../../hooks/password-gate', () => ({
  usePasswordGate: () => ({ requestAuth: vi.fn(), PasswordModal: null }),
}));
vi.mock('../../../utils/navigate', () => ({ useBackNav: () => vi.fn() }));
vi.mock('../../../services/zcashme/config', () => ({
  useZcashMeDirectoryLookup: () => () => undefined,
}));
vi.mock('../../../services/zcashme/label', () => ({ zcashMeLabel: () => undefined }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ threadId: ALICE }),
}));

import { ThreadPage } from './thread';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollTo = () => undefined;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const render = () => act(() => root.render(createElement(ThreadPage)));
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label);

describe('a direct thread', () => {
  it('shows text, a request as a pay card, a payment line and a card that claims nothing', () => {
    store.messages.messages = [
      msg({ txId: 'a', content: 'final logo files are up. invoice below' }),
      msg({ txId: 'b', content: `zcash:${ALICE}?amount=1.25&message=logo%20design` }),
      msg({
        txId: 'c',
        direction: 'sent',
        recipientAddress: ALICE,
        senderAddress: undefined,
        content: 'looks great, paying now',
        amount: '1.25',
      }),
      msg({ txId: 'd', asset: 'contact-card', content: 'mallory\nu1cardaddress' }),
    ];
    render();
    expect(text()).toContain('final logo files are up');
    expect(text()).toContain('requests');
    expect(text()).toContain('1.25');
    expect(text()).toContain('logo design');
    expect(text()).toContain('you paid 1.25 zec');
    expect(text()).toContain('a card · not checked yet');
    expect(text()).not.toMatch(/verified|checked in person/);

    act(() => button('pay')!.click());
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/link?uri=zcash%3A'));
    act(() => button('save')!.click());
    expect(addContact).toHaveBeenCalledWith({ name: 'mallory' });
  });

  it('never offers to pay a request you sent yourself', () => {
    store.messages.messages = [
      msg({
        txId: 'r',
        direction: 'sent',
        recipientAddress: ALICE,
        senderAddress: undefined,
        content: `zcash:u1mine?amount=2`,
      }),
    ];
    render();
    expect(text()).toContain('you asked for');
    expect(button('pay')).toBeUndefined();
  });

  it('marks what you received as read once it is on screen', () => {
    store.messages.messages = [msg({ id: 'u', txId: 'u', content: 'hi', read: false })];
    render();
    expect(store.messages.markRead).toHaveBeenCalledWith('u');
  });
});
