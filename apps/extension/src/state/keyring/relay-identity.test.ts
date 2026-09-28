import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./zcash', () => ({ initZcashWasm: vi.fn(async () => {}) }));

const keypairCounter = vi.hoisted(() => ({ n: 0 }));
vi.mock('/zafu-wasm/zafu_wasm.js', () => ({
  frost_relay_generate_keypair: () => {
    keypairCounter.n += 1;
    const tag = keypairCounter.n.toString(16).padStart(2, '0');
    return JSON.stringify({ private: 'a'.repeat(62) + tag, public: 'b'.repeat(62) + tag });
  },
  frost_relay_sign_challenge: () => '00'.repeat(64),
  FrostRelayCipher: class {},
}));

import { Key } from '@repo/encryption/key';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import {
  isEncryptedKey,
  isEncryptedWrapper,
  markHydrated,
  readEncrypted,
} from '../encrypted-storage';
import {
  getOrCreateRelayIdentity,
  RelayIdentityLockedError,
  type StoredRelayIdentity,
} from './relay-identity';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const readStored = () =>
  readEncrypted<Record<string, StoredRelayIdentity>>(
    localExtStorage,
    sessionExtStorage,
    'frostRelayIdentities',
  );

describe('relay identity storage', () => {
  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    keypairCounter.n = 0;
    markHydrated();
    const { key } = await Key.create('correct horse battery staple');
    await sessionExtStorage.set('passwordKey', await key.toJson());
  });

  it('is encrypted at rest and round-trips through the encrypted wrapper', async () => {
    expect(isEncryptedKey('frostRelayIdentities')).toBe(true);

    const identity = await getOrCreateRelayIdentity('group-a');

    const raw = await localExtStorage.get('frostRelayIdentities');
    expect(isEncryptedWrapper(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain(identity.privateKey);

    const stored = await readStored();
    expect(stored?.['group-a']).toEqual(identity);
  });

  it('keeps both entries when two groups are created concurrently', async () => {
    const [a, b] = await Promise.all([
      getOrCreateRelayIdentity('group-a'),
      getOrCreateRelayIdentity('group-b'),
    ]);

    const stored = await readStored();
    expect(stored?.['group-a']).toEqual(a);
    expect(stored?.['group-b']).toEqual(b);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('fails closed instead of handing back a group key it cannot persist', async () => {
    // locked: the session key is gone, so nothing can be sealed
    sessionMock.clear();

    await expect(getOrCreateRelayIdentity('group-locked')).rejects.toThrow(
      RelayIdentityLockedError,
    );

    // and the device is left exactly as it was - no half-written map
    expect(await localExtStorage.get('frostRelayIdentities')).toBeUndefined();
    expect(await readStored()).toBeNull();
  });

  it('persists the group key once the wallet is unlocked', async () => {
    sessionMock.clear();
    await expect(getOrCreateRelayIdentity('group-a')).rejects.toThrow(RelayIdentityLockedError);

    const { key } = await Key.create('correct horse battery staple');
    await sessionExtStorage.set('passwordKey', await key.toJson());

    const identity = await getOrCreateRelayIdentity('group-a');
    expect((await readStored())?.['group-a']).toEqual(identity);
  });
});
