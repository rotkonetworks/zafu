import { describe, expect, it } from 'vitest';
import type { CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { sourceChainPicks } from './source-chains';

const ALL: CosmosChainId[] = [
  'noble',
  'cosmoshub',
  'osmosis',
  'injective',
  'celestia',
  'kava',
  'axelar',
];
const live = new Set<CosmosChainId>(ALL);

describe('sourceChainPicks', () => {
  it('puts chains holding funds first and the closing one last', () => {
    const held = new Map([['celestia' as CosmosChainId, { amounts: ['0.160966 tia'] }]]);
    const keys = sourceChainPicks(ALL, live, new Set(ALL), held).map(p => p.key);
    expect(keys[0]).toBe('celestia');
    expect(keys.at(-1)).toBe('noble');
  });

  it('says empty after a check and not checked before one', () => {
    const picks = sourceChainPicks(['osmosis', 'kava'], live, new Set(['osmosis']), new Map());
    expect(picks.map(p => p.value)).toEqual(['empty', 'not checked']);
  });

  it('leaves out a chain without a route unless it still holds funds', () => {
    const offered = new Set<CosmosChainId>(['osmosis']);
    const held = new Map([['kava' as CosmosChainId, { amounts: ['4.2 kava', '1 usdt'] }]]);
    const picks = sourceChainPicks(['osmosis', 'kava', 'axelar'], offered, new Set(), held);
    expect(picks.map(p => p.key)).toEqual(['kava', 'osmosis']);
    expect(picks[0]).toMatchObject({ description: 'channel closed', value: '4.2 kava +1' });
  });

  it('marks the closing chain with its move-out date', () => {
    const [noble] = sourceChainPicks(['noble'], live, new Set(), new Map());
    expect(noble?.description).toBe('closing · move out by 2026-12-01');
  });
});
