/**
 * voting persistence — encrypted hotkey and delegation state storage
 *
 * stores per-round voting hotkeys and delegation state blobs in encrypted
 * local storage, using the same seal/unseal pattern as FROST multisig secrets.
 * the voting hotkey is a hot app-owned secret (64-byte random) — treated with
 * the same security as ephemeralSeed/keyPackage.
 */

import { Key } from '@repo/encryption/key';
import { Box } from '@repo/encryption/box';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';

export interface VotingRoundRecord {
  roundId: string;
  walletId: string;
  hotkeySecretHex: string;
  hotkeyPubkeyHex: string;
  delegationStateJson: string | null;
  createdAt: number;
}

interface StoredVotingRecord {
  roundId: string;
  walletId: string;
  hotkeySecretBox: string; // JSON-stringified BoxJson
  hotkeyPubkeyHex: string; // stored plaintext (not sensitive)
  delegationStateBox: string | null; // JSON-stringified BoxJson, null if not yet set
  createdAt: number;
}

/**
 * Get the voting hotkeys storage namespace: a map of [walletId:roundId] -> StoredVotingRecord
 */
const getVotingStorage = async (
  local: ExtensionStorage<LocalStorageState>,
): Promise<Record<string, StoredVotingRecord>> => {
  // votingHotkeys is stored in an extension that's not in the schema, so we cast to any
  const stored = await (local as any).get('votingHotkeys');
  return (stored as Record<string, StoredVotingRecord>) ?? {};
};

/**
 * Persist voting hotkeys storage back to local
 */
const setVotingStorage = async (
  local: ExtensionStorage<LocalStorageState>,
  storage: Record<string, StoredVotingRecord>,
): Promise<void> => {
  // votingHotkeys is stored in an extension that's not in the schema, so we cast to any
  await (local as any).set('votingHotkeys', storage);
};

/**
 * Generate storage key from walletId and roundId
 */
const storageKey = (walletId: string, roundId: string): string => {
  return `${walletId}:${roundId}`;
};

/**
 * Save (or update) the voting hotkey for a round.
 * Encrypts the hotkey secret with the session key, stores plaintext pubkey.
 * The hotkey secret is NEVER stored unencrypted.
 */
export const saveVotingHotkey = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  hotkeySecretHex: string,
  hotkeyPubkeyHex: string,
): Promise<void> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked — cannot save voting hotkey');
  }

  const key = await Key.fromJson(sessionKeyJson);
  // P1: bind the record's identity INTO the sealed plaintext so a ciphertext
  // cannot be relocated to another [walletId:roundId] key (all records share the
  // session key, so without this an attacker with storage access could swap
  // hotkeys/delegation-state across rounds or wallets). Verified on load.
  const hotkeySecretBox = JSON.stringify(
    (await key.seal(JSON.stringify({ v: 1, walletId, roundId, secret: hotkeySecretHex }))).toJson(),
  );

  const storage = await getVotingStorage(local);
  const key_str = storageKey(walletId, roundId);
  const existing = storage[key_str];

  storage[key_str] = {
    roundId,
    walletId,
    hotkeySecretBox,
    hotkeyPubkeyHex,
    delegationStateBox: existing?.delegationStateBox ?? null,
    createdAt: existing?.createdAt ?? Date.now(),
  };

  await setVotingStorage(local, storage);
};

/**
 * Update (or create) the delegation state blob for a round.
 * The blob is treated as opaque JSON produced by wasm — stored verbatim.
 * If the hotkey hasn't been saved yet, this will be deferred when hotkey is saved.
 */
export const saveDelegationState = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  delegationStateJson: string,
): Promise<void> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked — cannot save delegation state');
  }

  const storage = await getVotingStorage(local);
  const key_str = storageKey(walletId, roundId);
  const existing = storage[key_str];

  // P2 (fail-closed): delegation state must NEVER precede the hotkey - the hotkey
  // is generated before delegation, and a record with delegation state but an
  // empty hotkey is a footgun (casting would run with an empty seed). Reject
  // instead of manufacturing a partial record.
  if (!existing || !existing.hotkeySecretBox) {
    throw new Error(
      'cannot save delegation state before the voting hotkey for this round is persisted',
    );
  }

  const key = await Key.fromJson(sessionKeyJson);
  // P1: bind identity into the sealed plaintext (see saveVotingHotkey).
  const delegationStateBox = JSON.stringify(
    (
      await key.seal(JSON.stringify({ v: 1, walletId, roundId, state: delegationStateJson }))
    ).toJson(),
  );

  storage[key_str] = {
    ...existing,
    delegationStateBox,
  };

  await setVotingStorage(local, storage);
};

/**
 * Load a voting round record, decrypting both hotkey secret and delegation state.
 * Returns null if the record doesn't exist.
 */
export const loadVotingRoundRecord = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
): Promise<VotingRoundRecord | null> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked — cannot load voting round');
  }

  const key = await Key.fromJson(sessionKeyJson);
  const storage = await getVotingStorage(local);
  const key_str = storageKey(walletId, roundId);
  const stored = storage[key_str];

  if (!stored) {
    return null;
  }

  // Unseal an identity-bound field (P1): decrypt, parse, and verify the embedded
  // walletId/roundId match the key we loaded under - reject a relocated blob.
  // Fail-closed (P3): any decrypt/parse/identity failure throws; we never return
  // a partial or empty secret silently.
  const unsealBound = async (
    boxJson: string,
    field: 'secret' | 'state',
    label: string,
  ): Promise<string> => {
    const box = Box.fromJson(JSON.parse(boxJson));
    const decrypted = await key.unseal(box);
    if (!decrypted) {
      throw new Error(`failed to decrypt voting ${label} (tamper or wrong key)`);
    }
    const parsed = JSON.parse(decrypted) as {
      v: number;
      walletId: string;
      roundId: string;
      secret?: string;
      state?: string;
    };
    if (parsed.walletId !== walletId || parsed.roundId !== roundId) {
      throw new Error(`voting ${label} identity mismatch - blob relocated across keys`);
    }
    const value = parsed[field];
    if (typeof value !== 'string') {
      throw new Error(`voting ${label} malformed`);
    }
    return value;
  };

  // P2: a stored record must always carry a hotkey (delegation-before-hotkey is
  // rejected at write time); an empty box here is corruption, not "no secret".
  if (!stored.hotkeySecretBox) {
    throw new Error('voting round record has no hotkey - corrupt or partial record');
  }

  let hotkeySecretHex: string;
  try {
    hotkeySecretHex = await unsealBound(stored.hotkeySecretBox, 'secret', 'hotkey');
  } catch (e) {
    throw new Error(`failed to load voting hotkey: ${e instanceof Error ? e.message : String(e)}`);
  }

  let delegationStateJson: string | null = null;
  if (stored.delegationStateBox) {
    try {
      delegationStateJson = await unsealBound(
        stored.delegationStateBox,
        'state',
        'delegation state',
      );
    } catch (e) {
      throw new Error(
        `failed to load delegation state: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    roundId: stored.roundId,
    walletId: stored.walletId,
    hotkeySecretHex,
    hotkeyPubkeyHex: stored.hotkeyPubkeyHex,
    delegationStateJson,
    createdAt: stored.createdAt,
  };
};

/**
 * Purge a voting round record after the reveal window closes.
 * Deletes both hotkey and delegation state.
 */
export const purgeVotingRound = async (
  local: ExtensionStorage<LocalStorageState>,
  walletId: string,
  roundId: string,
): Promise<void> => {
  const storage = await getVotingStorage(local);
  const key_str = storageKey(walletId, roundId);
  delete storage[key_str];
  await setVotingStorage(local, storage);
};
