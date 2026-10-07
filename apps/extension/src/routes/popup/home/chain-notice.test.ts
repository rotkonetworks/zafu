import { describe, expect, test } from 'vitest';
import { CHAIN_NOTICE, chainNoticeOf } from './chain-notice';

describe('the chain notice on zcash home', () => {
  test('a node that stopped proving pauses, with a way on: another node or keep this one', () => {
    const id = chainNoticeOf(true, { status: 'failed', reason: 'downgrade' });
    expect(id).toBe('downgrade');
    expect(CHAIN_NOTICE[id!].actions).toEqual(['choose', 'accept']);
    expect(CHAIN_NOTICE[id!].quiet).toBeUndefined();
  });

  test('a proof that did not check out pauses, and only another node is offered', () => {
    const id = chainNoticeOf(true, { status: 'failed' });
    expect(id).toBe('paused');
    expect(CHAIN_NOTICE[id!].actions).toEqual(['choose']);
  });

  test('trees off the proof pause too, whatever the last check said', () => {
    expect(chainNoticeOf(true, { status: 'checked' })).toBe('paused');
    expect(chainNoticeOf(true)).toBe('paused');
  });

  test('a node kept unverified shows balances with a quiet note', () => {
    const id = chainNoticeOf(false, { status: 'unverified', reason: 'accepted' });
    expect(id).toBe('accepted');
    expect(CHAIN_NOTICE[id!]).toMatchObject({
      quiet: true,
      lines: ['chain not verified', expect.any(String)],
    });
  });

  test('a timeout or a 5xx is said quietly, never silently', () => {
    const id = chainNoticeOf(false, { status: 'unverified', reason: 'unreachable' });
    expect(id).toBe('unverified');
    expect(CHAIN_NOTICE[id!]).toMatchObject({
      quiet: true,
      lines: ['chain not verified', expect.any(String)],
    });
  });

  test("the computer's clock never pauses: a word, no action", () => {
    const id = chainNoticeOf(false, { status: 'unverified', reason: 'clock' });
    expect(id).toBe('clock');
    expect(CHAIN_NOTICE[id!].tone).toBe('info');
    expect(CHAIN_NOTICE[id!].actions).toBeUndefined();
  });

  test('a checked chain, a testnet or a plain lightwalletd says nothing', () => {
    expect(chainNoticeOf(false, { status: 'checked' })).toBeUndefined();
    expect(chainNoticeOf(false, { status: 'unverified', reason: 'testnet' })).toBeUndefined();
    expect(chainNoticeOf(false, { status: 'unverified', reason: 'lightwalletd' })).toBeUndefined();
    expect(chainNoticeOf(false)).toBeUndefined();
  });
});
