import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let rooms: unknown[] = [];
let down = false;
const peopleCall = vi.fn(async () => {
  if (down) {
    throw new Error('relay down');
  }
  return { ok: true };
});
vi.mock('../../../people/client', () => ({
  peopleCall: (op: string, a: unknown) => peopleCall(op, a),
  useMyRooms: () => rooms,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

import { cardLine, WaitingCards } from './waiting-cards';

const card = { bytes: '', mine: true, contactId: 'x', shown: 1, state: 'waiting' as const };

describe('a waiting card says what happened to it last', () => {
  it('shown, then copied, then shared; answers and a close in flight come first', () => {
    expect(cardLine(card)).toEqual(['card shown on screen', 1]);
    expect(cardLine({ ...card, copied: 5 })).toEqual(['link copied', 5]);
    expect(cardLine({ ...card, copied: 5, shared: 9 })).toEqual(['link shared', 9]);
    expect(cardLine({ ...card, copied: 9, shared: 5 })).toEqual(['link copied', 9]);
    const a = { b64: '', via: 'relay' as const, sealed: true, at: 7 };
    expect(cardLine({ ...card, answers: [a, { ...a, at: 8 }] })).toEqual(['2 answers arrived', 8]);
    expect(cardLine({ ...card, state: 'cancelling', at: 3 })).toEqual(['cancelling', 3]);
  });
});

describe('cancelling a card', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rooms = [{ id: 'c:1', kind: 'card', card: { ...card, shown: Date.now() } }];
    down = false;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });
  const button = (name: string) =>
    [...document.body.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('each row names what it cancels, and the dot rests when motion is reduced', async () => {
    await act(async () => root.render(createElement(WaitingCards)));
    const cancel = container.querySelector('button[aria-label^="cancel the card"]');
    expect(cancel?.getAttribute('aria-label')).toMatch(
      /cancel the card, card shown on screen today/,
    );
    expect(container.querySelector('.motion-reduce\\:animate-none')).not.toBeNull();
  });

  it('a cancel the relay did not take says so, and the sheet stays to try again', async () => {
    down = true;
    await act(async () => root.render(createElement(WaitingCards)));
    await act(async () => (container.querySelector('button[aria-label]') as HTMLElement).click());
    await act(async () => button('cancel card').click());
    expect(document.body.textContent).toContain('the relay did not take it yet');
    expect(button('try again')).toBeDefined();
    down = false;
    await act(async () => button('try again').click());
    expect(peopleCall).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('cancel this card?');
  });

  it('a close still on its way shows as cancelling, with nothing to tap twice', async () => {
    rooms = [{ id: 'c:1', kind: 'card', card: { ...card, state: 'cancelling', at: Date.now() } }];
    await act(async () => root.render(createElement(WaitingCards)));
    expect(container.textContent).toContain('cancelling');
    expect(container.textContent).toContain('zafu tries again when people opens');
    expect(container.querySelector('button[aria-label]')).toBeNull();
  });
});
