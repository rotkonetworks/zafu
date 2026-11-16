import { describe, expect, it } from 'vitest';
import { deriveHyperliquidAddress } from '@repo/wallet/networks/hyperliquid/derive';
import {
  accountPath,
  accountsOf,
  activeOf,
  customPathOf,
  mergeRestored,
  nameOf,
  parseBook,
  pathOf,
  rowsOf,
  scanAccounts,
  withName,
  withNew,
  withTop,
  type WalletAccounts,
} from './accounts';

/**
 * The first accounts of the standard test phrase, as viem publishes them
 * (wevm/viem test/src/constants.ts, fetched 2026-11-16): the same accounts
 * anvil and hardhat hand out, at m/44'/60'/0'/0/n.
 */
const TEST_PHRASE = 'test test test test test test test test test test test junk';
const TEST_ACCOUNTS = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
];

const CUSTOM = "m/44'/60'/2000'/1/0";
const fresh: WalletAccounts = { top: 0, names: {} };

describe('hyperliquid accounts are the standard evm accounts of the seed', () => {
  it('derives the published address at each index', () => {
    TEST_ACCOUNTS.forEach((address, n) => {
      expect(deriveHyperliquidAddress(TEST_PHRASE, accountPath(n))).toBe(address);
    });
  });

  it('keeps account 0 the address a wallet had before there were accounts', () => {
    expect(pathOf(activeOf(fresh, undefined), undefined)).toBe("m/44'/60'/0'/0/0");
    expect(deriveHyperliquidAddress(TEST_PHRASE)).toBe(TEST_ACCOUNTS[0]);
  });
});

describe('making and naming accounts', () => {
  it('hands out the next index with no gap, and moves to it', () => {
    const two = withNew(withNew(fresh));
    expect(two).toMatchObject({ top: 2, active: 2 });
    expect(rowsOf(two, undefined).map(r => [r.id, r.name, r.sub])).toEqual([
      [0, 'main', 'account 0'],
      [1, 'account 1', 'account 1'],
      [2, 'account 2', 'account 2'],
    ]);
  });

  it('names are optional: an empty one goes back to the number', () => {
    const named = withName(withNew(fresh), 1, '  trading ');
    expect(nameOf(named, 1)).toBe('trading');
    expect(nameOf(withName(named, 1, ''), 1)).toBe('account 1');
  });

  it('lists an imported path beside the indexed accounts, never in place of one', () => {
    const w = { ...withNew(fresh), active: 'path' as const };
    expect(rowsOf(w, CUSTOM).map(r => r.id)).toEqual([0, 1, 'path']);
    expect(pathOf(activeOf(w, CUSTOM), CUSTOM)).toBe(CUSTOM);
    // every indexed account still derives on its own standard path
    expect(pathOf(1, CUSTOM)).toBe("m/44'/60'/0'/0/1");
    // the path removed: the wallet is on account 0 again, not on a key that is gone
    expect(activeOf(w, undefined)).toBe(0);
  });

  it('never uses an account past the highest one handed out', () => {
    expect(activeOf({ top: 1, names: {}, active: 7 }, undefined)).toBe(0);
    expect(customPathOf('nonsense')).toBeUndefined();
    expect(customPathOf(CUSTOM)).toBe(CUSTOM);
  });

  it('only ever raises the highest index', () => {
    expect(withTop({ top: 4, names: {} }, 2).top).toBe(4);
    expect(withTop({ top: 4, names: {} }, 6).top).toBe(6);
    expect(withTop({ top: 4, names: {} }, -1).top).toBe(4);
  });
});

describe('restoring a backup', () => {
  const here = { alice: { top: 5, names: { 1: 'old' }, active: 3 } };

  it('never lowers the highest index, and takes the larger one', () => {
    expect(mergeRestored(here, { alice: { top: 2, names: {} } })['alice']!.top).toBe(5);
    expect(mergeRestored(here, { alice: { top: 9, names: {} } })['alice']!.top).toBe(9);
  });

  it("takes the backup's names, keeps the account in use, and adds wallets not here yet", () => {
    const next = mergeRestored(here, {
      alice: { top: 2, names: { 1: 'new', 2: 'savings' }, active: 0 },
      bob: { top: 1, names: {} },
    });
    expect(next['alice']).toEqual({ top: 5, names: { 1: 'new', 2: 'savings' }, active: 3 });
    expect(next['bob']).toEqual({ top: 1, names: {} });
  });

  it('carries a book through a backup and back, and drops what is malformed', () => {
    const book = { alice: { top: 3, names: { 2: 'burner', path: 'old account' }, active: 'path' } };
    const back = parseBook(JSON.parse(JSON.stringify(book)));
    expect(back).toEqual(book);
    expect(mergeRestored({}, back)).toEqual({
      alice: { top: 3, names: { 2: 'burner', path: 'old account' } },
    });
    expect(
      parseBook({ a: { top: -1 }, b: 'x', c: { top: 1, names: { x: 'y', 1: 7 }, active: 'z' } }),
    ).toEqual({ c: { top: 1, names: {} } });
    expect(accountsOf({}, 'nobody')).toEqual({ top: 0, names: {} });
  });
});

describe('looking for accounts from the seed alone', () => {
  const scan = async (used: number[], gap?: number) => {
    const asked: number[] = [];
    const found = await scanAccounts(async n => (asked.push(n), used.includes(n)), gap);
    return { found, asked };
  };

  it('finds accounts at 0, 2 and 6, and stops five past the last', async () => {
    const { found, asked } = await scan([0, 2, 6]);
    expect(found).toBe(6);
    // 7..11 are the five unused in a row; 12 is never asked
    expect(asked).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('stops after five when the seed was never used, asking each index once', async () => {
    expect(await scan([])).toEqual({ found: -1, asked: [0, 1, 2, 3, 4] });
  });

  it('does not see past a gap wider than five', async () => {
    expect((await scan([0, 6])).found).toBe(0);
    expect((await scan([0, 5])).found).toBe(5);
  });

  it('stops, rather than guess, when an answer could not be read', async () => {
    await expect(
      scanAccounts(async n => {
        if (n === 2) {
          throw new Error('no answer');
        }
        return n === 0;
      }),
    ).rejects.toThrow('no answer');
  });
});
