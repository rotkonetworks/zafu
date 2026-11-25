import { describe, expect, it } from 'vitest';
import { PENUMBRA_CHAINS, penumbraNetworkOf, testnetLine, viewDbsOf } from './chain';

const DEVNET = 'penumbra-testnet-brinance-1';

describe('penumbraNetworkOf', () => {
  it('is the testnet only while its switch is on', () => {
    expect(penumbraNetworkOf(['penumbra'])).toBe('penumbra');
    expect(penumbraNetworkOf(['penumbra', 'penumbra-testnet'])).toBe('penumbra-testnet');
    expect(penumbraNetworkOf(undefined)).toBe('penumbra');
    expect(penumbraNetworkOf('penumbra-testnet')).toBe('penumbra');
  });
});

describe('a testnet node', () => {
  const { refuse } = PENUMBRA_CHAINS['penumbra-testnet'];

  it('is read when it names a chain other than mainnet', () => {
    expect(refuse(DEVNET)).toBeUndefined();
  });

  it('is refused when it serves penumbra-1, or names no chain', () => {
    expect(refuse('penumbra-1')).toBe(
      'that node serves penumbra mainnet · please pick a testnet node',
    );
    expect(refuse('')).toBeDefined();
  });

  it('is asked on every start, and read from genesis', () => {
    expect(PENUMBRA_CHAINS['penumbra-testnet']).toMatchObject({
      askFirst: true,
      start: { creation: 0 },
    });
  });

  it('keeps its params apart from mainnet', () => {
    expect(PENUMBRA_CHAINS['penumbra-testnet'].params).not.toBe(PENUMBRA_CHAINS.penumbra.params);
    expect(PENUMBRA_CHAINS.penumbra).toMatchObject({ params: 'params', fallback: 'penumbra-1' });
    expect(PENUMBRA_CHAINS['penumbra-testnet'].fallback).toBeUndefined();
  });
});

describe('viewDbsOf', () => {
  const names = [
    'viewdata/penumbra-1/penumbrawalletid1a',
    `viewdata/${DEVNET}/penumbrawalletid1a`,
    'viewdata/penumbra-10/penumbrawalletid1a',
    'zafu-zcash',
  ];

  it("names one chain's databases, never another chain that shares its prefix", () => {
    expect(viewDbsOf(names, 'penumbra-1')).toEqual(['viewdata/penumbra-1/penumbrawalletid1a']);
    expect(viewDbsOf(names, DEVNET)).toEqual([`viewdata/${DEVNET}/penumbrawalletid1a`]);
  });
});

describe('testnetLine', () => {
  it('names the chain and says its coins have no value', () => {
    expect(testnetLine(DEVNET)).toBe(`penumbra testnet · ${DEVNET} · coins have no value`);
  });

  it('says nothing on mainnet', () => {
    expect(testnetLine('penumbra-1')).toBeUndefined();
    expect(testnetLine(undefined)).toBeUndefined();
  });
});
