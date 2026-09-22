import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RULES,
  itemIsHidden,
  modeStateAt,
  tallyDecision,
  type ModeRecord,
  type ModerationRules,
  type VoteRecord,
} from './vote';

const CH = 'chan-1';
const rules: ModerationRules = { ...DEFAULT_RULES, minElectorate: 3, windowLogs: 100 };

const mode = (m: ModeRecord['mode'], subject: string, at: number): ModeRecord => ({
  channel: CH,
  mode: m,
  subject,
  by: 'op',
  at,
});

const vote = (
  voter: string,
  decision: 'hide' | 'reveal',
  at: number,
  item = 'item-1',
): VoteRecord => ({
  channel: CH,
  item,
  decision,
  voter,
  at,
});

describe('modeStateAt', () => {
  const chain: ModeRecord[] = [
    mode('+o', 'op', 1),
    mode('+v', 'alice', 2),
    mode('+v', 'bob', 3),
    mode('+v', 'carol', 4),
    mode('-v', 'bob', 10),
    mode('+v', 'dave', 12),
  ];

  it('replays grants and revocations up to a log index', () => {
    expect(modeStateAt(chain, 3).voice).toEqual(['alice', 'bob']);
    expect(modeStateAt(chain, 4).voice).toEqual(['alice', 'bob', 'carol']);
    expect(modeStateAt(chain, 10).voice).toEqual(['alice', 'carol']);
    expect(modeStateAt(chain, 999).voice).toEqual(['alice', 'carol', 'dave']);
  });

  it('separates operators from the electorate', () => {
    const { ops, voice } = modeStateAt(chain, 999);
    expect(ops).toEqual(['op']);
    expect(voice).not.toContain('op');
  });
});

describe('tallyDecision', () => {
  const modes: ModeRecord[] = [
    mode('+v', 'alice', 1),
    mode('+v', 'bob', 1),
    mode('+v', 'carol', 1),
  ];

  it('passes at the threshold of the electorate and reports who voted', () => {
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5), vote('bob', 'hide', 6)],
      modes,
      rules,
      openedAt: 0,
      asOf: 50,
    });

    expect(t.electorate).toEqual(['alice', 'bob', 'carol']);
    expect(t.threshold).toBe(1); // ceil(3 * 1/3)
    expect(t.passed).toBe(true);
    expect(t.votes).toEqual(['alice', 'bob']);
    expect(t.rejected).toEqual([]);
  });

  it('does not count a vote from someone who was not voiced when they voted', () => {
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5), vote('mallory', 'hide', 5)],
      modes,
      rules,
      openedAt: 0,
      asOf: 50,
    });

    expect(t.votes).toEqual(['alice']);
    expect(t.rejected).toEqual([{ voter: 'mallory', reason: 'not voiced when they voted' }]);
  });

  it('keeps a vote cast while voiced, and refuses one cast after devoicing', () => {
    // Votes are EVENTS, not standing influence: devoicing a member later does not
    // rewrite what they did, because retroactive invalidation is exactly what an
    // audit trail exists to prevent. It does stop them voting again.
    const withRevoke = [...modes, mode('-v', 'alice', 7)];
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5), vote('bob', 'hide', 6)],
      modes: withRevoke,
      rules,
      openedAt: 0,
      asOf: 50,
    });
    expect(t.votes).toEqual(['alice', 'bob']);

    const after = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 9)],
      modes: withRevoke,
      rules,
      openedAt: 0,
      asOf: 50,
    });
    expect(after.votes).toEqual([]);
    expect(after.rejected).toEqual([{ voter: 'alice', reason: 'not voiced when they voted' }]);
  });

  it('counts one vote per voter: the first wins', () => {
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5), vote('alice', 'hide', 9)],
      modes,
      rules,
      openedAt: 0,
      asOf: 50,
    });

    expect(t.votes).toEqual(['alice']);
    expect(t.rejected).toEqual([{ voter: 'alice', reason: 'already voted on this decision' }]);
  });

  it('rejects votes outside the decision window', () => {
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 500)],
      modes,
      rules, // window 100 from openedAt 0
      openedAt: 0,
      asOf: 600,
    });

    expect(t.votes).toEqual([]);
    expect(t.rejected).toEqual([{ voter: 'alice', reason: 'outside the decision window' }]);
  });

  it('tallies hide and reveal separately', () => {
    const hide = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5)],
      modes,
      rules,
      openedAt: 0,
      asOf: 50,
    });
    const reveal = tallyDecision({
      item: 'item-1',
      decision: 'reveal',
      votes: [vote('alice', 'hide', 5)],
      modes,
      rules,
      openedAt: 0,
      asOf: 50,
    });

    expect(hide.passed).toBe(true);
    expect(reveal.passed).toBe(false);
    expect(reveal.votes).toEqual([]);
  });

  it('needs a quorum: nothing passes below minElectorate', () => {
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5)],
      modes: [mode('+v', 'alice', 1)],
      rules,
      openedAt: 0,
      asOf: 50,
    });

    expect(t.threshold).toBe(Number.POSITIVE_INFINITY);
    expect(t.passed).toBe(false);
  });

  it('ignores votes about other items', () => {
    const t = tallyDecision({
      item: 'item-1',
      decision: 'hide',
      votes: [vote('alice', 'hide', 5, 'another-item')],
      modes,
      rules,
      openedAt: 0,
      asOf: 50,
    });

    expect(t.votes).toEqual([]);
    expect(t.rejected).toEqual([]); // not a rejection: a different question
  });
});

describe('itemIsHidden', () => {
  const reason = { passed: true, votes: [], electorate: [], threshold: 1, rejected: [] };

  it('is false with no passed decisions', () => {
    expect(itemIsHidden([])).toBe(false);
    expect(
      itemIsHidden([{ ...reason, item: 'i', decision: 'hide', passed: false, asOf: 10 }]),
    ).toBe(false);
  });

  it('hides on a passed hide and restores on a LATER passed reveal', () => {
    const hideAt10 = { ...reason, item: 'i', decision: 'hide' as const, asOf: 10 };
    const revealAt20 = { ...reason, item: 'i', decision: 'reveal' as const, asOf: 20 };
    const hideAt20 = { ...reason, item: 'i', decision: 'hide' as const, asOf: 20 };
    const revealAt10 = { ...reason, item: 'i', decision: 'reveal' as const, asOf: 10 };

    expect(itemIsHidden([hideAt10])).toBe(true);
    expect(itemIsHidden([hideAt10, revealAt20])).toBe(false);
    // the log index decides, not the array order: a reveal that came first is
    // superseded by a later hide
    expect(itemIsHidden([revealAt10, hideAt20])).toBe(true);
  });
});
