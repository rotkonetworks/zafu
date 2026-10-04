import { beforeEach, describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (k: string) => ({ [k]: stored[k] }),
      set: async (v: Record<string, unknown>) => void Object.assign(stored, v),
    },
  },
});

import {
  DEFAULT_PEOPLE_RELAY,
  defaultPeopleRelay,
  movePeopleRelay,
  peopleRelays,
} from './people-relay';

describe('the people relay setting', () => {
  beforeEach(() => {
    stored = {};
  });

  it('moves the default and keeps the old one allowed for the rooms already there', async () => {
    await movePeopleRelay('https://relay.example.org');
    const s = stored['peopleRelay'] as never;
    expect(defaultPeopleRelay(s)).toBe('https://relay.example.org');
    expect(peopleRelays(s)).toEqual(['https://relay.example.org', DEFAULT_PEOPLE_RELAY]);
    // back to the built-in: stored blank, the other one stays allowed
    await movePeopleRelay(DEFAULT_PEOPLE_RELAY);
    expect(stored['peopleRelay']).toEqual({ endpoint: '', hosts: ['https://relay.example.org'] });
    expect(defaultPeopleRelay(stored['peopleRelay'] as never)).toBe(DEFAULT_PEOPLE_RELAY);
  });
});
