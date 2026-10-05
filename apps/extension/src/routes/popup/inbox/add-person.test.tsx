import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let params = new URLSearchParams();
const setParams = vi.fn((p: Record<string, string>) => {
  params = new URLSearchParams(p);
});
let rooms: unknown[] = [];
let cannot = false;
let relayOn = true;
const fresh = vi.fn();
const peopleAsk = vi.fn(async (op: string) => {
  if (op === 'card-open' && !relayOn) {
    throw new Error('the relay is not allowed yet');
  }
  return { id: 'c:room' };
});
const peopleCall = vi.fn(async () => ({ ok: true }));
const store = { contacts: { contacts: [], updateContact: vi.fn() } };

vi.mock('../../../state', () => ({
  useStore: (selector?: (s: typeof store) => unknown) => (selector ? selector(store) : store),
}));
vi.mock('../../../people/client', () => ({
  peopleAsk: (op: string, a: unknown) => peopleAsk(op, a),
  peopleCall: (op: string, a: unknown) => peopleCall(op, a),
  useMyRooms: () => rooms,
  usePeopleSlot: () => 'checked',
  useWatchRoom: () => undefined,
}));
vi.mock('../../../people/my-card', () => ({
  useMyCards: () => ({ ready: !cannot, cannot, fresh: () => fresh() }),
  useCardSync: () => undefined,
}));
vi.mock('../../../net/egress-opt-in', () => ({ requestEgressOptIn: vi.fn() }));
vi.mock('../../../components/qr-code', () => ({
  QrCode: ({ value }: { value: string }) => createElement('i', { 'data-qr': value }),
}));
vi.mock('../../../components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [params, setParams],
}));

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import {
  CARD_DEFAULT_RELAY,
  Cap,
  answersOf,
  cardB64,
  signCardV2,
  type CardV2,
} from '@repo/wallet/networks/zcash/card-v2';
import { AddPersonPage } from './add-person';

const signed = (n: number, o: Partial<CardV2> = {}) => {
  const seed = new Uint8Array(32).fill(n);
  const c: CardV2 = {
    kind: 'card',
    revision: 0,
    key: bytesToHex(ed25519.getPublicKey(seed)),
    pairKa: 'ab'.repeat(32),
    relay: CARD_DEFAULT_RELAY,
    caps: Cap.chat | Cap.sealed,
    created: 29_000_000,
    ...o,
  };
  return { b64: cardB64(signCardV2(c, seed)), key: c.key };
};
const mine = signed(1);
const answer = (n: number, name: string, sealed = true) => ({
  b64: signed(n, { kind: 'answer', answers: answersOf(mine.key), name }).b64,
  via: 'relay' as const,
  sealed,
  at: Date.UTC(2026, 9, 5, 9),
});
const freshCard = { b64: mine.b64, contactId: 'p1', rel: { gen: 0, j: 4 } };

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn(async () => undefined);
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  params = new URLSearchParams();
  rooms = [];
  cannot = false;
  relayOn = true;
  fresh.mockResolvedValue(freshCard);
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const render = () => act(async () => root.render(createElement(AddPersonPage)));
const text = () => container.textContent ?? '';
const button = (name: string | RegExp) =>
  [...container.querySelectorAll('button')].find(b =>
    typeof name === 'string' ? b.textContent === name : name.test(b.textContent ?? ''),
  )!;

describe('add a person', () => {
  it('a visit makes nothing: no relationship, no address, no watched room', async () => {
    await render();
    expect(fresh).not.toHaveBeenCalled();
    expect(peopleAsk).not.toHaveBeenCalled();
    expect(container.querySelector('[data-qr]')).toBeNull();
    expect(text()).toContain('show your card');
    expect(text()).toContain('made when you show, copy or share it');
  });

  it('showing makes one card, keeps its room, and puts it in the url', async () => {
    await render();
    await act(async () => button('show your card').click());
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(peopleAsk).toHaveBeenCalledWith(
      'card-open',
      expect.objectContaining({ card: mine.b64 }),
    );
    expect(setParams).toHaveBeenCalledWith({ room: 'c:room' }, { replace: true });
    await render();
    expect(container.querySelector('[data-qr]')?.getAttribute('data-qr')).toContain(mine.b64);
  });

  it('with the relay declined, the link is never copied, and allow tries the same card again', async () => {
    relayOn = false;
    await render();
    await act(async () => button(/copy link/).click());
    expect(writeText).not.toHaveBeenCalled();
    expect(container.querySelector('[data-qr]')).toBeNull();
    expect(text()).toContain('no one can answer until the relay is allowed');
    relayOn = true;
    await act(async () => button('allow').click());
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(peopleAsk).toHaveBeenCalledTimes(2);
  });

  it('a wallet with no recovery phrase here says so calmly, and makes nothing', async () => {
    cannot = true;
    await render();
    expect(text()).toContain('cards need a wallet whose recovery phrase is on this computer');
    expect(text()).not.toContain('making your card');
    expect(button(/copy link/)).toBeUndefined();
    expect(fresh).not.toHaveBeenCalled();
  });

  it('two answers: both shown, one chosen after its seal', async () => {
    params = new URLSearchParams({ room: 'c:room' });
    const ken = answer(2, 'ken');
    const other = answer(3, 'ken', false);
    rooms = [
      {
        id: 'c:room',
        kind: 'card',
        card: {
          bytes: mine.b64,
          mine: true,
          contactId: 'p1',
          shown: 1,
          state: 'waiting',
          answers: [ken, other],
        },
      },
    ];
    await render();
    expect(text()).toContain('2 answers arrived');
    expect(text()).toContain('not sealed');
    await act(async () => button(/^kensealed/).click());
    expect(container.querySelectorAll('ol li')).toHaveLength(6);
    await act(async () => button('it matches').click());
    expect(peopleCall).toHaveBeenCalledWith('card-choose', {
      roomId: 'c:room',
      key: signed(2).key,
      checked: true,
    });
  });

  it('an answer saved without the seal says the name and address are their word', async () => {
    params = new URLSearchParams({ room: 'c:room' });
    rooms = [
      {
        id: 'c:room',
        kind: 'card',
        card: { bytes: mine.b64, mine: true, contactId: 'p1', shown: 1, state: 'answered', at: 5 },
      },
    ];
    await render();
    expect(text()).toContain('your card was saved');
    expect(text()).toContain('seal not checked');
  });
});
