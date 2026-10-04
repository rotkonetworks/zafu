import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../state', () => ({ useStore: vi.fn() }));

import { pairSeal } from '../../../people/cards';
import { sourceLine } from './seal';

describe('the pair seal', () => {
  it('is the same picture on both screens, and another pair gets another', () => {
    const a = 'aa'.repeat(32);
    const b = 'bb'.repeat(32);
    expect(pairSeal(a, b)).toBe(pairSeal(b, a));
    expect(pairSeal(a, b)).not.toBe(pairSeal(a, 'cc'.repeat(32)));
  });

  it('until it is checked, a person shows where their card came from', () => {
    expect(sourceLine({ source: 'link' })).toBe('from a link');
    expect(sourceLine({ source: 'memo' })).toBe('from a memo');
    expect(sourceLine({ source: 'scan' })).toBe('from a qr');
    expect(sourceLine({ source: 'link', sealChecked: 1 })).toBe('seal checked in person');
    expect(sourceLine({})).toBeUndefined();
  });
});
