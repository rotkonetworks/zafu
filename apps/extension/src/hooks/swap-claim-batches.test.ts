import { describe, expect, it } from 'vitest';
import {
  claimBatches,
  pruneSent,
  RESEND_AFTER_BLOCKS,
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
