import { beforeEach, describe, expect, it } from 'vitest';
import {
  deriveAndCacheZidGeneration,
  deriveZidCrossSite,
  getZidGenKeys,
  getZidIndex,
  rotateZidIndex,
  rotateZidIndexDown,
  rotatedIdentity,
  setZidIndex,
} from './identity';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

const SEED_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('zid generations are per wallet', () => {
  beforeEach(() => {
    localMock.clear();
  });

  it('rotating one wallet leaves another wallet on its generation', async () => {
    await rotateZidIndex('wallet-a');
    await rotateZidIndex('wallet-a');
    expect(await getZidIndex('wallet-a')).toBe(2);
    expect(await getZidIndex('wallet-b')).toBe(0);
  });

  it('defaults to the selected vault', async () => {
    localMock.set('selectedVaultId', 'wallet-a');
    await rotateZidIndex();
    expect(await getZidIndex('wallet-a')).toBe(1);
    expect(await getZidIndex()).toBe(1);
    localMock.set('selectedVaultId', 'wallet-b');
    expect(await getZidIndex()).toBe(0);
  });

  it('inherits the pre-scoping global index until the wallet sets its own', async () => {
    // an upgraded install that had rotated to generation 3 must keep
    // presenting generation 3, not fall back to 0
    localMock.set('zidIndex', 3);
    expect(await getZidIndex('wallet-a')).toBe(3);
    expect(await getZidIndex('wallet-b')).toBe(3);

    await rotateZidIndexDown('wallet-a');
    expect(await getZidIndex('wallet-a')).toBe(2);
    expect(await getZidIndex('wallet-b')).toBe(3);
  });

  it('keeps a scoped 0 instead of falling back to the legacy index', async () => {
    localMock.set('zidIndex', 3);
    await setZidIndex(0, 'wallet-a');
    expect(await getZidIndex('wallet-a')).toBe(0);
  });

  it('caches each wallet its own generation keys', async () => {
    const a = await deriveAndCacheZidGeneration(SEED_A, 1, 'wallet-a');
    const b = await deriveAndCacheZidGeneration(SEED_B, 1, 'wallet-b');

    expect(a).toBe(deriveZidCrossSite(SEED_A, rotatedIdentity('default', 1)).publicKey);
    expect(a).not.toBe(b);
    expect((await getZidGenKeys('wallet-a'))[1]).toBe(a);
    expect((await getZidGenKeys('wallet-b'))[1]).toBe(b);
  });

  it('ignores the unscoped cache, which cannot say whose keys it holds', async () => {
    localMock.set('zidGenKeys', { 0: 'ab'.repeat(32) });
    localMock.set('selectedVaultId', 'wallet-a');
    expect(await getZidGenKeys()).toEqual({});
  });
});
