import { describe, expect, it } from 'vitest';
import {
  claimBatches,
  pruneSent,
  RESEND_AFTER_BLOCKS,
  sendClaimBatches,
  sentFromStored,
  sentToStored,
  type SentClaims,
} from './swap-claim-batches';

const um = (c: string) => ({ commitment: c, feeAsset: '' });
const usdc = (c: string) => ({ commitment: c, feeAsset: 'usdc' });

describe('claimBatches', () => {
  it('puts every ready claim with the same fee asset in one transaction', () => {
    expect(claimBatches([um('a'), um('b'), um('c')], new Map(), 100)).toEqual([['a', 'b', 'c']]);
  });

  it('splits claims prepaid in different fee assets', () => {
    expect(claimBatches([um('a'), usdc('b'), um('c')], new Map(), 100)).toEqual([
      ['a', 'c'],
      ['b'],
    ]);
  });

  it('skips a claim already sent until it lands or the resend window passes', () => {
    const sent: SentClaims = new Map([['a', 100]]);
    expect(claimBatches([um('a'), um('b')], sent, 101)).toEqual([['b']]);
    expect(claimBatches([um('a'), um('b')], sent, 100 + RESEND_AFTER_BLOCKS)).toEqual([['a', 'b']]);
  });

  it('has nothing to do when nothing is unclaimed', () => {
    expect(claimBatches([], new Map(), 1)).toEqual([]);
  });
});

describe('pruneSent', () => {
  it('forgets claims that are no longer unclaimed', () => {
    const sent: SentClaims = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    pruneSent(sent, [um('b')]);
    expect([...sent.keys()]).toEqual(['b']);
  });
});

describe('sendClaimBatches', () => {
  it('a batch that fails is sent one claim at a time, so one bad claim blocks none', async () => {
    const sent: SentClaims = new Map();
    const tried: string[][] = [];
    const n = await sendClaimBatches([['a', 'bad', 'c'], ['d']], sent, 10, batch => {
      tried.push(batch);
      return batch.includes('bad') ? Promise.reject(new Error('fee')) : Promise.resolve('sent');
    });
    expect(n).toBe(3);
    expect(tried).toEqual([['a', 'bad', 'c'], ['a'], ['bad'], ['c'], ['d']]);
    // the bad one is tried again only after the resend window
    expect(sent.get('bad')).toBe(10);
    expect(claimBatches([um('bad')], sent, 10 + RESEND_AFTER_BLOCKS - 1)).toEqual([]);
    expect(claimBatches([um('bad')], sent, 10 + RESEND_AFTER_BLOCKS)).toEqual([['bad']]);
  });

  it('the worker going away stops the round; the next block retries the rest', async () => {
    const sent: SentClaims = new Map();
    const n = await sendClaimBatches([['a'], ['b']], sent, 10, () => Promise.resolve('transient'));
    expect(n).toBe(0);
    expect(sent.size).toBe(0);
  });

  it('sent claims round-trip through session storage, ignoring anything malformed', () => {
    const sent: SentClaims = new Map([['a', 5]]);
    expect(sentFromStored(sentToStored(sent))).toEqual(sent);
    expect(sentFromStored({ a: 'x', b: 3 })).toEqual(new Map([['b', 3]]));
    expect(sentFromStored(undefined).size).toBe(0);
  });
});
