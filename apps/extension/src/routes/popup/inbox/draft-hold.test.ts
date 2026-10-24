import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, holdDraft, releaseDraft, takeDraft } from './draft-hold';

afterEach(() => vi.useRealTimers());

describe('draft hold', () => {
  it('gives the text back once', () => {
    holdDraft('t1', 'hello');
    expect(takeDraft('t1')).toBe('hello');
    expect(takeDraft('t1')).toBeUndefined();
  });

  it('forgets after a minute', () => {
    vi.useFakeTimers();
    holdDraft('t2', 'hello');
    vi.advanceTimersByTime(HOLD_MS + 1);
    expect(takeDraft('t2')).toBeUndefined();
  });

  it('drops a draft once a memo carrying it is sent', () => {
    holdDraft('t3', 'see you');
    releaseDraft('see you\nreply:u1abc');
    expect(takeDraft('t3')).toBeUndefined();
  });

  it('keeps a draft another memo does not carry', () => {
    holdDraft('t4', 'see you');
    releaseDraft('something else');
    expect(takeDraft('t4')).toBe('see you');
  });
});
