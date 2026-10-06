import { describe, expect, it, vi } from 'vitest';
import type { Utxo } from '../state/keyring/zidecar-client';
import { DEFAULT_PRIVACY_SETTINGS } from '../state/privacy';
import { planDeposit, type DepositChain, type DepositWasm } from '../workers/transparent-deposit';
import { ledgerTransparentSendFlowBtc } from '../ledger/hw-btc-flow';
import { Key } from '@repo/encryption/key';
import { storage } from '@repo/mock-chrome';
import { markHydrated } from '../state/encrypted-storage';
import {
  checkKey,
  fromStored,
  newTip,
  readCheck,
  runCheck,
  saveCheck,
  toStored,
  type TransparentCheck,
} from './zcash-check';

const utxo = (address: string, valueZat: bigint): Utxo => ({
  address,
  txid: new Uint8Array(32),
  outputIndex: 0,
  script: new Uint8Array(25),
  valueZat,
  height: 1,
});

/** a node that answers per address, recording every request */
const fakeNode = (coins: Record<string, bigint>) => {
  const asked: unknown[] = [];
  return {
    asked,
    getAddressUtxos: vi.fn(async (address: string) => {
      asked.push(address);
      return coins[address] ? [utxo(address, coins[address])] : [];
    }),
  };
};

describe('zcash transparent check', () => {
  it('is off by default: no per-block refresh unless the user turns it on', () => {
    expect(DEFAULT_PRIVACY_SETTINGS.zcashTransparentEachBlock).toBe(false);
    expect(newTip(DEFAULT_PRIVACY_SETTINGS.zcashTransparentEachBlock, 3_000_000, null)).toBe(false);
  });

  it('check now asks each address in its own request, every one exactly once', async () => {
    const node = fakeNode({ t1b: 5n, t1c: 7n });
    const addresses = ['t1a', 't1b', 't1c', 't1d'];
    const c = await runCheck(node, addresses, 100, 42);
    expect(node.getAddressUtxos).toHaveBeenCalledTimes(addresses.length);
    for (const a of node.asked) {
      expect(typeof a).toBe('string');
    }
    expect([...node.asked].sort()).toEqual(addresses);
    expect(c).toMatchObject({ at: 42, height: 100, zat: 12n, funded: 2 });
  });

  it('skips blank slots and asks a repeated address once', async () => {
    const node = fakeNode({});
    await runCheck(node, ['', 't1a', 't1a', ''], 0);
    expect(node.asked).toEqual(['t1a']);
  });

  it('the opt-in refresh fires on a new tip and not otherwise', () => {
    const last: TransparentCheck = { at: 0, height: 100, zat: 0n, funded: 0 };
    expect(newTip(true, 101, last)).toBe(true);
    expect(newTip(true, 100, last)).toBe(false);
    expect(newTip(true, 99, last)).toBe(false);
    expect(newTip(false, 101, last)).toBe(false);
    // no tip yet (connecting) never asks
    expect(newTip(true, 0, null)).toBe(false);
    expect(newTip(true, 1, null)).toBe(true);
  });

  it('round-trips through storage without the coins, and reads anything else as never checked', () => {
    const c: TransparentCheck = {
      at: 1,
      height: 2,
      zat: 30n,
      funded: 1,
      utxos: [utxo('t1a', 30n)],
    };
    const stored = JSON.parse(JSON.stringify(toStored(c))) as unknown;
    expect(stored).not.toHaveProperty('utxos');
    expect(fromStored(stored)).toEqual({ at: 1, height: 2, zat: 30n, funded: 1 });
    expect(fromStored(undefined)).toBeNull();
    expect(fromStored({ encrypted: 'abc' })).toBeNull();
    expect(fromStored({ at: 1, height: 2, zat: '-1', funded: 0 })).toBeNull();
  });
});

describe('the last check at rest', () => {
  it('is sealed, never plaintext, and reads as never checked once locked', async () => {
    await storage.local.clear();
    await storage.session.clear();
    const key = (await Key.create('test-password')).key;
    await storage.session.set({ passwordKey: await key.toJson() });
    markHydrated();
    const c: TransparentCheck = { at: 5, height: 6, zat: 987654321n, funded: 3 };
    expect(await saveCheck('w1', c)).toBe(true);
    const raw = (await storage.local.get(checkKey('w1')))[checkKey('w1')];
    expect(raw).toHaveProperty('encrypted');
    expect(JSON.stringify(raw)).not.toContain('987654321');
    expect(await readCheck('w1')).toEqual(c);
    await storage.session.clear();
    expect(await readCheck('w1')).toBeNull();
    // locked: nothing written
    expect(await saveCheck('w2', c)).toBe(false);
    expect(await storage.local.get(checkKey('w2'))).toEqual({});
  });
});

describe('flows ask only their own address', () => {
  it('a swap deposit prices from its one address', async () => {
    const chain = {
      utxos: vi.fn(async () => []),
      tip: vi.fn(),
      branchId: vi.fn(),
      broadcast: vi.fn(),
    } as unknown as DepositChain;
    const wasm = {
      plan_transparent_transaction: () => JSON.stringify({ fee: 0, change: 0, short: 1 }),
    } as unknown as DepositWasm;
    await planDeposit(wasm, chain, {
      tAddress: 't1swap',
      tIndex: 3,
      to: 't1vault',
      amountZat: '1',
      memo: '',
      mainnet: true,
    });
    expect(chain.utxos).toHaveBeenCalledTimes(1);
    expect(chain.utxos).toHaveBeenCalledWith('t1swap');
  });

  it('a ledger transparent send asks its source address alone', async () => {
    const fetchUtxos = vi.fn(async () => []);
    await expect(
      ledgerTransparentSendFlowBtc(
        {} as never,
        {
          serverUrl: 'https://node',
          fromAddresses: ['t1from'],
          recipientAddress: 't1to',
          amountZat: 1n,
          feeZat: 1n,
          change: { address: 't1from', path: "m/44'/133'/0'/0/0" } as never,
          accountIndex: 0,
          mainnet: true,
          blockHeight: 1,
        },
        { fetchUtxos, broadcast: vi.fn() },
      ),
    ).rejects.toThrow(/no spendable/);
    expect(fetchUtxos).toHaveBeenCalledTimes(1);
    expect(fetchUtxos).toHaveBeenCalledWith('https://node', 't1from');
  });
});
