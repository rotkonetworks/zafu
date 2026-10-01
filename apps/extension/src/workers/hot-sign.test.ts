import { describe, expect, test, vi } from 'vitest';
import { Key } from '@repo/encryption/key';
import { issueWorkerKey, sealKeyTo, type SealedVault } from '../shared/vault-seal';
import {
  VAULT_LOCKED,
  unsealVault,
  withSpendKeys,
  type SpendKeys,
  type SpendKeysCtor,
} from './hot-sign';

const SENTINEL = 'sentinel phrase that must only reach the wasm constructor inside the worker';

/** a vault sealed with a fresh password key, its key wrapped to a fresh worker key */
const sealed = async (phrase = SENTINEL): Promise<SealedVault> => {
  const { key } = await Key.create('a password');
  const box = JSON.stringify((await key.seal(phrase)).toJson());
  return { box, seal: await sealKeyTo(await key.toJson(), await issueWorkerKey()) };
};

/** a SpendKeys stand-in that records what it was built from */
const fakeKeys = () => {
  const seen: { phrase: string; account: number; mainnet: boolean }[] = [];
  const free = vi.fn();
  const Ctor = vi.fn(function (phrase: string, account: number, mainnet: boolean) {
    seen.push({ phrase, account, mainnet });
    return { free, ufvk: () => `uview-${account}` } as unknown as SpendKeys;
  }) as unknown as SpendKeysCtor;
  return { Ctor, seen, free };
};

describe('withSpendKeys', () => {
  test('opens the vault in the worker and builds the keys for the given account', async () => {
    const { Ctor, seen, free } = fakeKeys();
    const ufvk = await withSpendKeys(Ctor, await sealed(), 3, false, async keys => keys.ufvk());
    expect(ufvk).toBe('uview-3');
    expect(seen).toEqual([{ phrase: SENTINEL, account: 3, mainnet: false }]);
    expect(free).toHaveBeenCalledOnce();
  });

  test('frees the keys when the send fails, and the error carries no phrase', async () => {
    const { Ctor, free } = fakeKeys();
    const run = withSpendKeys(Ctor, await sealed(), 0, true, () =>
      Promise.reject(new Error('broadcast failed')),
    );
    await expect(run).rejects.toThrow('broadcast failed');
    expect(free).toHaveBeenCalledOnce();
  });

  test.each([
    ['no vault', async () => undefined],
    [
      'a key from another session',
      async () => ({ ...(await sealed()), seal: (await sealed()).seal }),
    ],
    [
      'a damaged box',
      async () => ({ ...(await sealed()), box: '{"nonce":"AA","cipherText":"AA"}' }),
    ],
    ['not a box at all', async () => ({ ...(await sealed()), box: SENTINEL })],
  ])('%s: the same calm error, nothing built, nothing leaked', async (_, vault) => {
    const { Ctor, seen } = fakeKeys();
    const error = await withSpendKeys(Ctor, await vault(), 0, true, async () => 'never').catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toBe(VAULT_LOCKED);
    expect((error as Error).message).not.toContain('sentinel');
    expect(seen).toEqual([]);
  });

  test('a sealed vault opens once: a replayed one is refused', async () => {
    const vault = await sealed();
    await expect(unsealVault(vault)).resolves.toBe(SENTINEL);
    await expect(unsealVault(vault)).rejects.toThrow(VAULT_LOCKED);
  });
});
