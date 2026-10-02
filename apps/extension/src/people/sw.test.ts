/**
 * The people relay's egress gate: people-relay on, and the room's relay one
 * the person allowed. An unknown relay is never contacted without an allow.
 *
 * @vitest-environment node
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('../state', () => ({ useStore: { getState: () => ({}) } }));

const { peopleGate } = await import('./sw');

const DEFAULT = 'https://zcash.rotko.net';

describe('peopleGate', () => {
  test('off by default: ask', () => {
    expect(peopleGate({}, DEFAULT)).toBe('ask');
  });

  test('on once people-relay is allowed', () => {
    expect(peopleGate({ netEgress: { optIns: { 'people-relay': 'allowed' } } }, DEFAULT)).toBe(
      'on',
    );
  });

  test('blocked when the person blocked it', () => {
    expect(peopleGate({ netEgress: { optIns: { 'people-relay': 'blocked' } } }, DEFAULT)).toBe(
      'blocked',
    );
  });

  test('a relay nobody allowed needs its own allow, even with people-relay on', () => {
    const on = { netEgress: { optIns: { 'people-relay': 'allowed' as const } } };
    expect(peopleGate(on, 'https://relay.stranger.example')).toBe('ask');
    expect(
      peopleGate(
        { ...on, peopleRelay: { hosts: ['https://relay.stranger.example'] } },
        'https://relay.stranger.example',
      ),
    ).toBe('on');
  });

  test('a host the person blocked stays blocked', () => {
    expect(
      peopleGate(
        {
          netEgress: {
            optIns: { 'people-relay': 'allowed' },
            destinations: { 'zcash.rotko.net': { state: 'blocked' } },
          },
        },
        DEFAULT,
      ),
    ).toBe('blocked');
  });
});
