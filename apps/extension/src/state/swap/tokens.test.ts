import { describe, expect, it } from 'vitest';
import type { SwapToken } from './provider';
import { chainName, chainsOf, searchTokens } from './tokens';

const t = (symbol: string, chain: string): SwapToken => ({ symbol, chain, decimals: 6 });
const tokens = [
  t('USDC', 'sol'),
  t('USDC', 'base'),
  t('USDC', 'eth'),
  t('ETH', 'arb'),
  t('ETH', 'eth'),
  t('WETH', 'base'),
  t('PEPE', 'eth'),
  t('BNB', 'bsc'),
  t('CAKE', 'bsc'),
  t('ATOM', 'gaia'),
];
const shown = (ts: SwapToken[]) => ts.map(x => `${x.symbol}@${x.chain}`);

describe('searchTokens', () => {
  it('puts the coin itself first, then what is on that chain', () => {
    const r = shown(searchTokens(tokens, 'eth'));
    expect(r.slice(0, 2)).toEqual(['ETH@eth', 'ETH@arb']);
    expect(r).toEqual(expect.arrayContaining(['USDC@eth', 'PEPE@eth', 'WETH@base']));
  });

  it('narrows with more words', () => {
    expect(shown(searchTokens(tokens, 'usdc base'))).toEqual(['USDC@base']);
    expect(shown(searchTokens(tokens, 'base usdc'))).toEqual(['USDC@base']);
  });

  it('knows chain names and aliases', () => {
    expect(shown(searchTokens(tokens, 'ethereum'))).toEqual(['ETH@eth', 'USDC@eth', 'PEPE@eth']);
    expect(shown(searchTokens(tokens, 'bep20')).sort()).toEqual(['BNB@bsc', 'CAKE@bsc']);
    expect(shown(searchTokens(tokens, 'cosmos'))).toEqual(['ATOM@gaia']);
  });

  it('stays on the chosen chain', () => {
    expect(shown(searchTokens(tokens, '', 'base'))).toEqual(['USDC@base', 'WETH@base']);
    expect(searchTokens(tokens, 'pepe', 'base')).toEqual([]);
  });

  it('lists popular coins first when nothing is typed', () => {
    expect(shown(searchTokens(tokens, '')).slice(0, 3)).toEqual(['ETH@eth', 'ETH@arb', 'USDC@eth']);
  });
});

describe('chainsOf', () => {
  it('orders popular chains first, then by size, with counts', () => {
    expect(chainsOf(tokens)).toEqual([
      { chain: 'eth', count: 3 },
      { chain: 'sol', count: 1 },
      { chain: 'base', count: 2 },
      { chain: 'arb', count: 1 },
      { chain: 'bsc', count: 2 },
      { chain: 'gaia', count: 1 },
    ]);
  });

  it('names chains, and falls back to the code', () => {
    expect(chainName('bsc')).toBe('bnb chain');
    expect(chainName('newchain')).toBe('newchain');
  });
});
