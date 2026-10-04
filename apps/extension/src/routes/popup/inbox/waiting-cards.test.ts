import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../people/client', () => ({ peopleCall: vi.fn(), useMyRooms: () => [] }));
vi.mock('./add-person', () => ({ hhmm: () => '14:02' }));

import { cardLine } from './waiting-cards';

describe('a waiting card says what happened to it last', () => {
  const card = { bytes: '', mine: true, contactId: 'x', shown: 1, state: 'waiting' as const };
  it('shown, then copied, then shared', () => {
    expect(cardLine(card)).toEqual(['card shown on screen', 1]);
    expect(cardLine({ ...card, copied: 5 })).toEqual(['link copied', 5]);
    expect(cardLine({ ...card, copied: 5, shared: 9 })).toEqual(['link shared', 9]);
    expect(cardLine({ ...card, copied: 9, shared: 5 })).toEqual(['link copied', 9]);
  });
});
