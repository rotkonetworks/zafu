import { describe, expect, it } from 'vitest';
import { chatPrivacy, sendLine, withReply, withoutReply } from './chat';

describe('where a line of yours stands', () => {
  it('says only what zafu knows: sending, waiting, failed, or on the relay', () => {
    expect(sendLine({ status: 'sending', ts: 1 })?.text).toBe('sending');
    expect(sendLine({ status: 'waiting', ts: 1 })?.text).toBe('waiting to send');
    expect(sendLine({ status: 'failed', ts: 1 })).toMatchObject({ tone: 'failed' });
    expect(sendLine({ ts: 1_700_000_000 }, true)).toMatchObject({ mark: true });
    expect(sendLine({ ts: 1_700_000_000 }, true)?.text).toMatch(/^sent \d\d:\d\d$/);
  });

  it('never claims delivery or presence the relay cannot know', () => {
    for (const status of ['sending', 'waiting', 'failed', undefined] as const) {
      expect(sendLine({ status, ts: 1 }, true)?.text).not.toMatch(/deliver|read|online|seen/);
    }
  });

  it('says read, with the time they said it, only for a line on the relay', () => {
    expect(sendLine({ ts: 1 }, true, 1_700_000_000)?.text).toMatch(/^read \d\d:\d\d$/);
    expect(sendLine({ ts: 1, status: 'waiting' }, true, 1_700_000_000)?.text).toBe(
      'waiting to send',
    );
  });

  it('keeps a group quiet once a line is on the relay', () => {
    expect(sendLine({ ts: 1 })).toBeUndefined();
  });
});

describe('who sees what', () => {
  it('a pair room is end-to-end encrypted and names the relay, never "only online"', () => {
    const p = chatPrivacy('relay', 'ken', 'relay.zafu.pro', false);
    expect(p.lines[0]).toBe('end-to-end encrypted');
    expect(p.lines[1]).toContain('relay.zafu.pro sees your ip');
    expect(p.lines[0]).not.toContain('post-quantum');
    expect(JSON.stringify(p)).not.toMatch(/only that you are online/);
  });

  it('says post-quantum only once the room moved, and that lines wait while it moves', () => {
    expect(chatPrivacy('relay', 'ken', 'r', false, 'on').lines[0]).toBe(
      'end-to-end encrypted · post-quantum',
    );
    expect(chatPrivacy('relay', 'ken', 'r', false, 'securing').lines[0]).toContain('wait');
    expect(chatPrivacy('relay', 'ken', 'r', false, 'off').explain.blurb).toContain(
      'not post-quantum yet',
    );
  });

  it('a memo thread says it is shielded payments, a transparent one says public', () => {
    expect(chatPrivacy('memo', 'ken', 'r', false).lines[0]).toBe('shielded payments with a note');
    expect(chatPrivacy('memo', 'ken', 'r', true).lines[0]).toBe('public payments');
  });
});

describe('the reply line', () => {
  it('rides under the note, or alone, and comes off for display', () => {
    expect(withReply('lunch', 'u1me')).toBe('lunch\nreply:u1me');
    expect(withReply('', 'u1me')).toBe('reply:u1me');
    expect(withReply('lunch')).toBe('lunch');
    expect(withoutReply('lunch\nreply:u1me')).toBe('lunch');
    expect(withoutReply('reply:u1me')).toBe('');
  });
});
