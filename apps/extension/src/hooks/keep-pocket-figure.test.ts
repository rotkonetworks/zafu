import { describe, expect, it } from 'vitest';
import { pocketStoreId } from '../state/pocket-id';
import { keepPocketFigure } from './zcash-pool-balances';

const from = (storeId: string) => ({ queryKey: ['zcashWorker', storeId, 'balance'] });

describe('keepPocketFigure', () => {
  it("keeps the last pocket's figure while switching pockets of one wallet", () => {
    expect(keepPocketFigure(pocketStoreId('A', 2))(5n, from('A'))).toBe(5n);
    expect(keepPocketFigure('A')(5n, from(pocketStoreId('A', 1)))).toBe(5n);
  });

  it("never shows another wallet's figure", () => {
    expect(keepPocketFigure('B')(5n, from('A'))).toBeUndefined();
    expect(
      keepPocketFigure(pocketStoreId('B', 1))(5n, from(pocketStoreId('A', 1))),
    ).toBeUndefined();
  });

  it('has nothing to keep with no store or no previous one', () => {
    expect(keepPocketFigure(undefined)(5n, from('A'))).toBeUndefined();
    expect(keepPocketFigure('A')(5n, undefined)).toBeUndefined();
  });
});
