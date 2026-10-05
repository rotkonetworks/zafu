/**
 * The worker's "the relay is not on" error reaches the screens as text. The
 * screens must still tell it apart, or a first group, card or join fails with
 * "please try again" instead of asking for the relay (a copy pass once
 * reworded the error and silently broke exactly this).
 */
import { describe, expect, it, vi } from 'vitest';

let allowed = false;
const sent: string[] = [];
vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: async (m: { op: string }) => {
      sent.push(m.op);
      return allowed
        ? { ok: true, value: { id: 'g:x' } }
        : { ok: false, error: new PeopleNeedsRelay('ask').message };
    },
  },
});
const ask = vi.fn(async () => {
  allowed = true;
  return true;
});
vi.mock('../net/egress-opt-in', () => ({ requestEgressOptIn: () => ask() }));

import { PeopleNeedsRelay } from './service';
import { isRelayGated, isRelayNotOn } from './protocol';
import { peopleAsk } from './client';

describe('the relay gate across the message boundary', () => {
  it('reads the worker errors by their own words', () => {
    const notOn = new Error(new PeopleNeedsRelay('ask').message);
    const off = new Error(new PeopleNeedsRelay('blocked').message);
    expect(isRelayNotOn(notOn)).toBe(true);
    expect(isRelayNotOn(off)).toBe(false);
    expect(isRelayGated(notOn)).toBe(true);
    expect(isRelayGated(off)).toBe(true);
    expect(isRelayGated(new Error('sorry, something else'))).toBe(false);
  });

  it('asks for the relay once, then tries again', async () => {
    await expect(peopleAsk('group-create', { name: 'studio' })).resolves.toEqual({ id: 'g:x' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['group-create', 'group-create']);
  });
});
