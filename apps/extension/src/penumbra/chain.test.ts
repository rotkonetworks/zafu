import { describe, expect, it } from 'vitest';
import {
  PENUMBRA_CHAINS,
  chainLine,
  penumbraNetworkOf,
  planChainProblem,
  testnetNodeProblem,
  viewDbsOf,
} from './chain';

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

describe('chainLine', () => {
  it('names a testnet chain and says its coins have no value', () => {
    expect(chainLine({ network: 'penumbra-testnet', chainId: DEVNET })).toBe(
      `penumbra testnet · ${DEVNET} · coins have no value`,
    );
  });

  it('says so when the testnet has no node yet, rather than look like mainnet', () => {
    expect(chainLine({ network: 'penumbra-testnet' })).toBe('penumbra testnet · no node yet');
  });

  it('says nothing on mainnet', () => {
    expect(chainLine({ network: 'penumbra', chainId: 'penumbra-1' })).toBeUndefined();
  });
});

describe('planChainProblem', () => {
  const mainnet = { network: 'penumbra' as const, chainId: 'penumbra-1' };
  const testnet = { network: 'penumbra-testnet' as const, chainId: DEVNET };

  it('a plan for the chain in use is fine', () => {
    expect(planChainProblem('penumbra-1', mainnet)).toBeUndefined();
    expect(planChainProblem(DEVNET, testnet)).toBeUndefined();
  });

  it('a plan naming a testnet while mainnet is in use is refused, never labelled valueless', () => {
    expect(planChainProblem(DEVNET, mainnet)).toBe(
      `this transaction names ${DEVNET} · zafu is on penumbra-1`,
    );
  });

  it('a plan naming mainnet while the testnet is in use is refused', () => {
    expect(planChainProblem('penumbra-1', testnet)).toBe(
      `this transaction names penumbra-1 · zafu is on ${DEVNET}`,
    );
  });

  it('a testnet with no named chain signs nothing', () => {
    expect(planChainProblem(DEVNET, { network: 'penumbra-testnet' })).toBe(
      'penumbra testnet has no node yet',
    );
    expect(planChainProblem(undefined, mainnet)).toBe('this transaction names no chain');
  });
});

describe('testnetNodeProblem', () => {
  it('a node on this computer may speak plain http', () => {
    for (const u of ['http://127.0.0.1:38080', 'http://localhost:8080', 'http://[::1]:8080']) {
      expect(testnetNodeProblem(u)).toBeUndefined();
    }
  });

  it('any other node needs https', () => {
    expect(testnetNodeProblem('https://testnet.example.org')).toBeUndefined();
    expect(testnetNodeProblem('http://testnet.example.org')).toBe(
      'a node away from this computer needs https',
    );
    expect(testnetNodeProblem('http://192.168.1.5:8080')).toBeDefined();
    expect(testnetNodeProblem('not a url')).toBeDefined();
  });
});
