import { describe, expect, it } from 'vitest';
import type { Message } from '../../../state/messages';
import { cardOf, deriveThreads, previewOf, whenOf } from './threads';

const msg = (over: Partial<Message>): Message => ({
  id: over.txId ?? 'id',
  network: 'zcash',
  recipientAddress: '',
  content: 'hi',
  txId: 't',
  blockHeight: 1,
  timestamp: 1,
  direction: 'received',
  read: false,
  ...over,
});

describe('deriveThreads', () => {
  it('puts a send and a reply to the same address in one thread, newest first', () => {
    const threads = deriveThreads([
      msg({ txId: 'a', direction: 'sent', recipientAddress: 'u1Alice', timestamp: 10, read: true }),
      msg({ txId: 'b', senderAddress: 'u1alice', timestamp: 20 }),
      msg({ txId: 'c', senderAddress: 'u1bob', timestamp: 15 }),
    ]);
    expect(threads.map(t => t.id)).toEqual(['u1alice', 'u1bob']);
    expect(threads[0]!.messages.map(m => m.txId)).toEqual(['a', 'b']);
    expect(threads[0]!.unread).toBe(1);
    expect(threads[0]!.address).toBe('u1Alice');
  });

  it('never merges two senders it cannot name', () => {
    const threads = deriveThreads([msg({ txId: 'x' }), msg({ txId: 'y' })]);
    expect(threads.map(t => t.id).sort()).toEqual(['s:x', 's:y']);
    expect(threads[0]!.address).toBeUndefined();
  });
});

describe('previewOf', () => {
  it('says what a payment without text was', () => {
    expect(previewOf(msg({ content: '', amount: '0.5' }))).toBe('received 0.5 zec');
    expect(previewOf(msg({ content: '', amount: '1', direction: 'sent' }))).toBe('you paid 1 zec');
  });
});

describe('whenOf', () => {
  const now = new Date(2026, 9, 2, 15, 0).getTime();
  it('reads like the board', () => {
    expect(whenOf(new Date(2026, 9, 2, 14, 2).getTime(), now)).toBe('14:02');
    expect(whenOf(new Date(2026, 9, 1, 9, 0).getTime(), now)).toBe('yesterday');
    expect(whenOf(new Date(2026, 8, 12).getTime(), now)).toBe('sep 12');
  });
});

describe('cardOf', () => {
  it('reads a stored card, old pictograph or not, and nothing else', () => {
    const old = msg({ asset: 'contact-card', content: '\u{1F4C7} alice\nu1abc' });
    expect(cardOf(old)).toEqual({ name: 'alice', address: 'u1abc' });
    expect(cardOf(msg({ asset: 'contact-card', content: '\nu1abc' }))).toEqual({
      name: '',
      address: 'u1abc',
    });
    expect(cardOf(msg({ content: 'alice\nu1abc' }))).toBeUndefined();
  });
});

describe('a reply with no reply: line', () => {
  it('lands in the thread of the person you gave that address to', () => {
    const threads = deriveThreads([
      msg({
        txId: 'out',
        direction: 'sent',
        recipientAddress: 'u1Bob',
        senderAddress: undefined,
        timestamp: 1,
        read: true,
      }),
      msg({ txId: 'in', senderAddress: undefined, personAddress: 'u1bob', timestamp: 2 }),
    ]);
    expect(threads.map(t => t.id)).toEqual(['u1bob']);
    expect(threads[0]!.messages.map(m => m.txId)).toEqual(['out', 'in']);
  });

  it('trusts your own record over the address the memo declares', () => {
    const [t] = deriveThreads([msg({ senderAddress: 'u1mallory', personAddress: 'u1bob' })]);
    expect(t!.id).toBe('u1bob');
  });
});
