/**
 * voting persistence - encrypted hotkey and delegation state storage
 *
 * stores per-round voting hotkeys and delegation state blobs in encrypted
 * local storage, using the same seal/unseal pattern as FROST multisig secrets.
 * the voting hotkey is a hot app-owned secret (64-byte random) - treated with
 * the same security as ephemeralSeed/keyPackage.
 */

import { Key } from '@repo/encryption/key';
import { Box } from '@repo/encryption/box';
import { keyUse } from '../../state/keyring-lock';
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
const saveVotingHotkeyUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  hotkeySecretHex: string,
  hotkeyPubkeyHex: string,
): Promise<void> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked - cannot save voting hotkey');
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
 * The blob is treated as opaque JSON produced by wasm - stored verbatim.
 * If the hotkey hasn't been saved yet, this will be deferred when hotkey is saved.
 */
const saveDelegationStateUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  delegationStateJson: string,
): Promise<void> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked - cannot save delegation state');
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
const loadVotingRoundRecordUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
): Promise<VotingRoundRecord | null> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked - cannot load voting round');
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
 * One cast, kept from before its POST until its shares are out: the recovery
 * bundle (share secrets; it rebuilds shares that carry the vote's choice),
 * the bundle's next delegation state, and how far it got. All of it sits in
 * one identity-bound sealed box, so neither the choice nor which tx is this
 * wallet's vote is readable from storage.
 */
export interface VoteCastRecord {
  proposalId: number;
  /** the signed POST /cast-vote body: re-sent as is, never rebuilt */
  wire: string;
  commitmentBundleJson: string;
  nextDelegationStateJson: string;
  /** set once a vote server reported the cast tx */
  txHash?: string;
  /** set once the cast is included: where it landed in the commitment tree */
  position?: { height: number; vcPosition: number; vanPosition: number };
  /** set once the helper shares went out */
  sharesQueued?: boolean;
}

const castKey = (walletId: string, roundId: string, proposalId: number): string =>
  `${walletId}:${roundId}:${proposalId}`;

const getCastStorage = async (
  local: ExtensionStorage<LocalStorageState>,
): Promise<Record<string, string>> =>
  // votingCasts is not in the schema (like votingHotkeys)
  ((await (local as any).get('votingCasts')) as Record<string, string> | undefined) ?? {};

const saveVoteCastUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  cast: VoteCastRecord,
): Promise<void> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked - cannot save the vote');
  }
  const key = await Key.fromJson(sessionKeyJson);
  // P1: the record's identity is inside the sealed plaintext (see saveVotingHotkey)
  const box = JSON.stringify(
    (await key.seal(JSON.stringify({ v: 1, walletId, roundId, cast }))).toJson(),
  );
  const storage = await getCastStorage(local);
  storage[castKey(walletId, roundId, cast.proposalId)] = box;
  await (local as any).set('votingCasts', storage);
};

const loadVoteCastUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  proposalId: number,
): Promise<VoteCastRecord | null> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked - cannot load the vote');
  }
  const boxJson = (await getCastStorage(local))[castKey(walletId, roundId, proposalId)];
  if (!boxJson) {
    return null;
  }
  const key = await Key.fromJson(sessionKeyJson);
  const opened = await key.unseal(Box.fromJson(JSON.parse(boxJson)));
  if (!opened) {
    throw new Error('failed to decrypt the stored vote (tamper or wrong key)');
  }
  const parsed = JSON.parse(opened) as {
    walletId: string;
    roundId: string;
    cast?: VoteCastRecord;
  };
  if (
    parsed.walletId !== walletId ||
    parsed.roundId !== roundId ||
    parsed.cast?.proposalId !== proposalId ||
    typeof parsed.cast.commitmentBundleJson !== 'string' ||
    typeof parsed.cast.wire !== 'string'
  ) {
    throw new Error('stored vote identity mismatch - blob relocated across keys');
  }
  return parsed.cast;
};

/** Drop one cast's record (refused on chain, or done with). */
export const deleteVoteCast = async (
  local: ExtensionStorage<LocalStorageState>,
  walletId: string,
  roundId: string,
  proposalId: number,
): Promise<void> => {
  const storage = await getCastStorage(local);
  delete storage[castKey(walletId, roundId, proposalId)];
  await (local as any).set('votingCasts', storage);
};

/**
 * Purge a voting round record after the reveal window closes.
 * Deletes the hotkey, the delegation state and the round's sealed casts.
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
  const casts = await getCastStorage(local);
  const prefix = `${walletId}:${roundId}:`;
  for (const k of Object.keys(casts).filter(k => k.startsWith(prefix))) {
    delete casts[k];
  }
  await (local as any).set('votingCasts', casts);
};

// each seals or opens with the session key: key users (state/keyring-lock)
export const saveVotingHotkey: typeof saveVotingHotkeyUnlocked = (...a) =>
  keyUse(() => saveVotingHotkeyUnlocked(...a));
export const saveDelegationState: typeof saveDelegationStateUnlocked = (...a) =>
  keyUse(() => saveDelegationStateUnlocked(...a));
export const loadVotingRoundRecord: typeof loadVotingRoundRecordUnlocked = (...a) =>
  keyUse(() => loadVotingRoundRecordUnlocked(...a));
export const saveVoteCast: typeof saveVoteCastUnlocked = (...a) =>
  keyUse(() => saveVoteCastUnlocked(...a));
export const loadVoteCast: typeof loadVoteCastUnlocked = (...a) =>
  keyUse(() => loadVoteCastUnlocked(...a));
