import { beforeEach, describe, expect, it, vi } from 'vitest';

const balances = vi.fn<(address: string, endpoint?: string) => Promise<unknown[]>>();
const derive = vi.fn((_: string, i: number) => Promise.resolve(`noble1addr${i}`));
vi.mock('@repo/wallet/networks/transparent/conduit', () => ({
  conduitFor: () => ({ deriveAddress: derive, queryBalances: balances }),
}));
vi.mock('@repo/storage-chrome/cosmos-chain-counters', () => ({ peekHdIndex: async () => 0 }));
vi.mock('../hooks/transparent-rpc', () => ({
  getRpcPool: async () => ['https://a.example', 'https://b.example'],
}));

import {
  ago,
  checkState,
  readCheck,
  runCheck,
  toDepositAssets,
  type ChainCheck,
} from './chain-check';
import { LEGACY_SCAN_GAP } from './hd';

const USDC = { denom: 'uusdc', amount: 1_500_000n };
const phrase = vi.fn(async () => 'test phrase');

beforeEach(async () => {
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
  vi.clearAllMocks();
});

describe('check state', () => {
  const check = (over: Partial<ChainCheck>): ChainCheck => ({
    at: 0,
    funded: [],
    missed: 0,
    ...over,
  });

  it('is off while the chain is off, whatever is cached', () => {
    expect(checkState({ enabled: false, checking: true, check: check({}) }).kind).toBe('off');
  });

  it('is not checked until the user asks', () => {
    expect(checkState({ enabled: true, checking: false, check: null }).kind).toBe('unchecked');
  });

  it('says checking while a check runs', () => {
    expect(checkState({ enabled: true, checking: true, check: check({}) }).kind).toBe('checking');
  });

  it('tells empty, funded and unanswered apart', () => {
    const funded = [{ index: 0, address: 'a', assets: [] }];
    const kind = (c: ChainCheck) => checkState({ enabled: true, checking: false, check: c }).kind;
    expect(kind(check({}))).toBe('empty');
    expect(kind(check({ funded }))).toBe('funded');
    expect(kind(check({ funded, missed: 2 }))).toBe('unanswered');
  });
});

describe('ago', () => {
  it('reads like a person would say it', () => {
    const now = 10 * 24 * 3_600_000;
    expect(ago(now - 20_000, now)).toBe('just now');
    expect(ago(now - 2 * 60_000, now)).toBe('2 min ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(ago(now - 4 * 24 * 3_600_000, now)).toBe('4 d ago');
  });
});

describe('runCheck', () => {
  it('rotates each address through its own endpoint and caches the result', async () => {
    balances.mockImplementation(async address => (address === 'noble1addr3' ? [USDC] : []));
    const check = await runCheck('k', 'noble', phrase);

    expect(check.missed).toBe(0);
    expect(check.funded.map(w => w.index)).toEqual([3]);
    expect(check.funded[0]!.assets[0]!.amount).toBe(1_500_000n);
    expect(balances).toHaveBeenCalledWith('noble1addr3', 'https://b.example');
    expect(balances).toHaveBeenCalledWith('noble1addr2', 'https://a.example');
    expect(balances).toHaveBeenCalledTimes(LEGACY_SCAN_GAP + 1);

    const cached = await readCheck('k', 'noble');
    expect(cached).toEqual(check);
    expect(await readCheck('other', 'noble')).toBeNull();
  });

  it('needs the phrase only for addresses it has not derived this session', async () => {
    balances.mockResolvedValue([]);
    await runCheck('k', 'noble', phrase);
    await runCheck('k', 'noble', phrase);
    expect(phrase).toHaveBeenCalledTimes(1);
    expect(derive).toHaveBeenCalledTimes(LEGACY_SCAN_GAP + 1);
  });

  it('keeps nothing but index numbers on disk', async () => {
    balances.mockImplementation(async address => (address === 'noble1addr3' ? [USDC] : []));
    await runCheck('k', 'noble', phrase);
    expect(JSON.stringify(await chrome.storage.local.get(null))).not.toContain('noble1addr');
  });

  it('falls back to the primary, and keeps the last known balance when nobody answers', async () => {
    balances.mockImplementation(async address => (address === 'noble1addr3' ? [USDC] : []));
    await runCheck('k', 'noble', phrase);

    balances.mockImplementation(async (address, endpoint) => {
      if (address === 'noble1addr3' || (address === 'noble1addr1' && endpoint)) {
        throw new TypeError('down');
      }
      return [];
    });
    const check = await runCheck('k', 'noble', phrase);
    expect(balances).toHaveBeenCalledWith('noble1addr1');
    expect(check.missed).toBe(1);
    expect(check.funded.map(w => w.index)).toEqual([3]);
  });
});

describe('toDepositAssets', () => {
  it("leads with the chain's own asset, not the biggest raw number", () => {
    const assets = toDepositAssets('injective', [
      { denom: 'inj', amount: 20_000_000_000_000_000n },
      { denom: 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', amount: 120_400_000n },
    ]);
    expect(assets.map(a => a.formatted)).toEqual(['120.4 USDC.inj', '0.02 INJ']);
  });
});

describe('one chain per check', () => {
  it("asks only that chain's conduit and node pool", async () => {
    const conduit = await import('@repo/wallet/networks/transparent/conduit');
    const rpc = await import('../hooks/transparent-rpc');
    const conduitFor = vi.spyOn(conduit, 'conduitFor');
    const pool = vi.spyOn(rpc, 'getRpcPool');
    balances.mockResolvedValue([]);
    await runCheck('vault-1', 'injective', phrase);
    expect(new Set(conduitFor.mock.calls.map(c => c[0]))).toEqual(new Set(['injective']));
    expect(pool.mock.calls.map(c => c[0])).toEqual(['injective']);
  });
});
