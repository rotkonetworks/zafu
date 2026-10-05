import { describe, expect, it } from 'vitest';
import { needsAsk } from './store';

const v = (id: string, on: boolean, why = on ? 'you-allowed' : 'default-off') => ({ id, on, why });

describe('the first look and the ask', () => {
  it('show while any of thornode, midgard and prices is still off', () => {
    expect(needsAsk([v('thorchain', false), v('midgard', false), v('near-swap', false)])).toBe(
      true,
    );
    // thornode allowed for a swap does not skip the others
    expect(needsAsk([v('thorchain', true), v('midgard', false), v('near-swap', true)])).toBe(true);
    expect(needsAsk([v('thorchain', true), v('midgard', true), v('near-swap', true)])).toBe(false);
  });

  it('never ask again for one the person blocked', () => {
    expect(
      needsAsk([v('thorchain', true), v('midgard', false, 'you-blocked'), v('near-swap', true)]),
    ).toBe(false);
  });
});
