import { describe, expect, test } from 'vitest';
import { releaseActive, type PocketTarget } from './accounts-sheet';
import type { AllSlices } from '../state';

const fakeTarget = (activeAccount: number): PocketTarget & { picked: number[] } => {
  const picked: number[] = [];
  return {
    active: () => activeAccount,
    pick: (_s, _owner, account) => {
      picked.push(account);
    },
    picked,
  };
};

describe('releaseActive', () => {
  test('switches away every network whose active pocket is the one being hidden, not just one', async () => {
    // mirrors zcash on account 1 (about to be hidden) and penumbra separately
    // on account 1 too - hiding it must release both, wherever the sheet
    // currently points
    const zcash = fakeTarget(1);
    const penumbra = fakeTarget(1);
    await releaseActive({} as AllSlices, 'owner', 1, [zcash, penumbra]);
    expect(zcash.picked).toEqual([0]);
    expect(penumbra.picked).toEqual([0]);
  });

  test('leaves a network alone when its active pocket is not the one being hidden', async () => {
    const zcash = fakeTarget(2);
    await releaseActive({} as AllSlices, 'owner', 1, [zcash]);
    expect(zcash.picked).toEqual([]);
  });
});
