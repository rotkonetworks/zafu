import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Lets react-dom's act() run outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The bubbles only need the store and the real codec. Everything else the
// route module imports (gRPC clients, sync hooks, dialogs) is replaced so this
// test exercises the trust decision, not module wiring.
const addContact = vi.fn(async () => ({ id: 'c1' }));
const addAddress = vi.fn(async () => ({}));
const findByAddress = vi.fn((_address: string): unknown => undefined);
const store = {
  contacts: { findByAddress, addContact, addAddress },
  frostSession: {
    signing: null as { roomCode: string } | null,
    dkg: null as { roomCode: string } | null,
    relayCeremonyId: null as string | null,
  },
};

vi.mock('../../../state', () => ({
  useStore: (selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store),
}));
vi.mock('../../../state/messages', () => ({ messagesSelector: (s: unknown) => s }));
vi.mock('../../../state/contacts', () => ({ contactsSelector: (s: typeof store) => s.contacts }));
vi.mock('../../../state/inbox', () => ({
  inboxSelector: (s: unknown) => s,
  selectConversations: () => [],
  selectUnreadCount: () => 0,
}));
vi.mock('../../../state/wallets', () => ({ selectVisibleMultisigWallets: () => [] }));
vi.mock('../../../state/keyring', () => ({
  selectActiveNetwork: () => 'zcash',
  selectPenumbraAccount: () => undefined,
  selectEffectiveKeyInfo: () => undefined,
}));
vi.mock('../../../clients', () => ({ viewClient: {} }));
vi.mock('../../../hooks/penumbra-memos', () => ({ usePenumbraMemos: () => ({}) }));
vi.mock('../../../hooks/zcash-memos', () => ({ useZcashMemos: () => ({}) }));
vi.mock('../../../hooks/penumbra-transaction', () => ({ usePenumbraTransaction: () => ({}) }));
vi.mock('../../../hooks/use-address', () => ({ useActiveAddress: () => ({}) }));
vi.mock('../../../state/diversified-addresses', () => ({
  getDiversifiedAddresses: async () => [],
}));
vi.mock('../../../services/zcashme/config', () => ({
  useZcashMeDirectoryLookup: () => () => undefined,
}));
vi.mock('../../../services/zcashme/label', () => ({ zcashMeLabel: () => undefined }));
vi.mock('../../../components/add-contact-dialog', () => ({ AddContactDialog: () => null }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import { MemoType, type ContactCard } from '@repo/wallet/networks/zcash/memo-codec';
import type { InboxMessage } from '../../../state/inbox';
import { ContactCardBubble, FrostSignBubble } from './index';

const CARD: ContactCard = {
  version: 1,
  flags: 0,
  name: 'mallory',
  address: 'u1cardaddress000000000000000000000000000000000000000000000000',
  zid: 'ab'.repeat(32),
};

const DELIVERING = 'u1someoneelse00000000000000000000000000000000000000000000000';

const signRequest = (sessionId: string | undefined): InboxMessage => ({
  id: 'tx-sign',
  type: MemoType.SignRequest,
  body: 'ff'.repeat(32),
  typeLabel: 'sign request',
  height: 100,
  txids: ['tx-sign'],
  complete: true,
  direction: 'incoming',
  sessionId,
  senderAddress: 'u1deliverer0000000000000000000000000000000000000000000000000',
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const render = (element: ReactElement): void => {
  act(() => {
    root.render(element);
  });
};

const text = (): string => container.textContent ?? '';
const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(b => b.textContent === label) as
    | HTMLButtonElement
    | undefined;

describe('contact card trust', () => {
  it('does not present a verified affordance when the delivering note disagrees', () => {
    render(
      createElement(ContactCardBubble, {
        card: CARD,
        deliveringAddress: DELIVERING,
      }),
    );

    // the card's own zid is never rendered as a verification glyph
    expect(container.querySelector('[class*="i-ph-fingerprint"]')).toBeNull();
    expect(text()).toContain('self-declared zid');
    expect(text()).toContain('unverified');
    expect(text()).not.toContain('address already in your contacts');
    // and it cannot be committed as a verified contact
    expect(button('save unverified')).toBeDefined();
    expect(button('save to contacts')).toBeUndefined();
    // the raw delivering address is shown next to the card
    expect(text()).toContain(DELIVERING);
  });

  it('does not claim verification when the delivering note declared no address', () => {
    render(createElement(ContactCardBubble, { card: CARD, deliveringAddress: undefined }));

    expect(text()).toContain('unverified');
    expect(button('save unverified')).toBeDefined();
    expect(button('save to contacts')).toBeUndefined();
  });

  it('stays unverified when the sender-authored address merely agrees with itself', () => {
    // both operands are the sender's own memo text: agreement is a claim, and a
    // card that forges a return address equal to its payload would pass it.
    render(createElement(ContactCardBubble, { card: CARD, deliveringAddress: CARD.address }));

    expect(text()).toContain('unverified');
    expect(text()).toContain("the note's sender declares this address");
    expect(button('save unverified')).toBeDefined();
    expect(button('save to contacts')).toBeUndefined();
  });

  it('accepts the card only when the address is already in this wallet\u2019s contacts', () => {
    findByAddress.mockReturnValue({ id: 'c1' });
    render(createElement(ContactCardBubble, { card: CARD, deliveringAddress: DELIVERING }));

    expect(text()).toContain('address already in your contacts');
    expect(text()).not.toContain('unverified');
    expect(button('save to contacts')).toBeUndefined();
    expect(text()).toContain('in contacts');
  });
});

describe('FROST sign request trust', () => {
  it('does not render the sign CTA for a memo naming an unknown session', () => {
    store.frostSession.signing = { roomCode: 'session-the-user-joined' };
    render(createElement(FrostSignBubble, { message: signRequest('session-from-chain') }));

    expect(button('sign transaction')).toBeUndefined();
    expect(text()).toContain('unverified');
  });

  it('does not render the sign CTA for a memo carrying no session id', () => {
    store.frostSession.signing = { roomCode: 'session-the-user-joined' };
    render(createElement(FrostSignBubble, { message: signRequest(undefined) }));

    expect(button('sign transaction')).toBeUndefined();
    expect(text()).toContain('unverified');
  });

  it('renders the sign CTA only for a locally-known session', () => {
    store.frostSession.signing = { roomCode: 'session-the-user-joined' };
    render(createElement(FrostSignBubble, { message: signRequest('session-the-user-joined') }));

    expect(button('sign transaction')).toBeDefined();
    expect(text()).not.toContain('unverified');
  });
});
