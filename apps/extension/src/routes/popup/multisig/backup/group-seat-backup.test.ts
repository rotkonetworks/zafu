/**
 * A group's seat in the encrypted seat backup: its key package and the room
 * it was made in go into the file, and a restore puts the seat back under
 * that room - under whichever wallet holds the room now.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openBackup, sealBackup } from '../../../../state/keyring/multisig-backup';

const newFrostMultisigKey = vi.fn(async (_p: Record<string, unknown>) => 'vault-2');
const updateMultisigWallet = vi.fn(async () => undefined);
vi.mock('../../../../state', () => ({
  useStore: {
    getState: () => ({
      keyRing: {
        newFrostMultisigKey,
        getMultisigSecrets: async () => ({ keyPackage: 'kp-secret', ephemeralSeed: 'seed-secret' }),
      },
      wallets: { updateMultisigWallet },
    }),
  },
}));
vi.mock('../../../../state/wallets', () => ({ selectMultisigWallets: () => [] }));
vi.mock('../../../../people/vault', () => ({
  readRooms: async () => [{ id: 'g:' + '1'.repeat(32), walletId: 'wallet-after-restore' }],
}));

const { importBackup } = await import('./import-helpers');
const { exportSingleBackup } = await import('./export-helpers');

const room = {
  walletId: 'wallet-before',
  roomId: 'g:' + '1'.repeat(32),
  ceremony: '2'.repeat(32),
  members: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
};
const share = {
  label: 'studio',
  publicKeyPackage: 'pkp',
  keyPackage: 'kp-secret',
  ephemeralSeed: 'seed-secret',
  threshold: 2,
  maxSigners: 3,
  mainnet: true,
  orchardFvk: 'uview1shared',
  address: 'u1shared',
  relayUrl: 'https://relay.zafu.pro',
  createdAt: 1,
  room,
};

describe('a group seat in the encrypted backup', () => {
  beforeEach(() => newFrostMultisigKey.mockClear());

  test('the file holds the key package and the room, sealed', async () => {
    const env = await sealBackup({ version: 1, type: 'frost-share-batch', shares: [share] }, 'pw', {
      label: 'all',
      shareCount: 1,
    });
    expect(JSON.stringify(env)).not.toContain('kp-secret');
    expect(JSON.stringify(env)).not.toContain(room.ceremony);
    const back = await openBackup(env, 'pw');
    expect(back?.type === 'frost-share-batch' && back.shares[0]).toMatchObject({
      keyPackage: 'kp-secret',
      room,
    });
  });

  test('restoring puts the seat back in its room, under the wallet that holds the room', async () => {
    const env = await sealBackup({ version: 1, type: 'frost-share', ...share }, 'pw', {
      label: 'studio',
    });
    expect(await importBackup(env, 'pw')).toEqual({ imported: 1, skipped: 0, total: 1 });
    expect(newFrostMultisigKey).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPackage: 'kp-secret',
        ephemeralSeed: 'seed-secret',
        threshold: 2,
        room: { ...room, walletId: 'wallet-after-restore' },
      }),
    );
  });

  test('backing up a group seat writes its room into the file', async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = (b: Blob) => ((blob = b), 'blob:x');
    URL.revokeObjectURL = () => undefined;
    await exportSingleBackup(
      {
        id: 'z1',
        label: 'studio',
        orchardFvk: 'uview1shared',
        address: 'u1shared',
        accountIndex: 0,
        mainnet: true,
        vaultId: 'vault-1',
        multisig: {
          publicKeyPackage: 'pkp',
          threshold: 2,
          maxSigners: 3,
          relayUrl: 'https://relay.zafu.pro',
          room,
        },
      },
      'pw',
    );
    const back = await openBackup(JSON.parse(await blob!.text()), 'pw');
    expect(back).toMatchObject({ type: 'frost-share', keyPackage: 'kp-secret', room });
    expect(updateMultisigWallet).toHaveBeenCalledWith('z1', expect.objectContaining({}));
  });
});
