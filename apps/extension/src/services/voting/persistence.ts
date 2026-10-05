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
 * the signed wire, the bundle's next delegation state, and how far it got.
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
  /** the helpers' reveal time, fixed when the shares are first built */
  submitAt?: number;
  /** share_index of every share at least one helper queued */
  sharesSent?: number[];
  /** set once every share is queued */
  sharesQueued?: boolean;
  /**
   * One operator refused the cast. Kept (never deleted on one say-so) until a
   * second, independent operator agrees.
   */
  refused?: { message: string; operators: string[] };
}

/**
 * All of one wallet's casts in one round live in ONE identity-bound sealed
 * box, under a hashed key: storage shows neither which proposals were voted
 * on, nor any choice, bundle or tx hash.
 */
interface CastBox {
  v: 1;
  walletId: string;
  roundId: string;
  casts: Record<string, VoteCastRecord>;
}

const CASTS = 'votingCasts';
const CASTS_LOCK = 'zafu-voting-casts';

/** Every read-modify-write of votingCasts runs under this one Web Lock. */
const castsLocked = <T>(fn: () => Promise<T>): Promise<T> =>
  navigator.locks.request(CASTS_LOCK, { mode: 'exclusive' }, fn) as Promise<T>;

const castBoxKey = async (walletId: string, roundId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`zafu-voting-casts:v1:${walletId}:${roundId}`),
  );
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

const getCastStorage = async (
  local: ExtensionStorage<LocalStorageState>,
): Promise<Record<string, string>> =>
  // votingCasts is not in the schema (like votingHotkeys)
  ((await (local as any).get(CASTS)) as Record<string, string> | undefined) ?? {};

const sessionKey = async (session: ExtensionStorage<SessionStorageState>): Promise<Key> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked - cannot open the stored votes');
  }
  return Key.fromJson(sessionKeyJson);
};

const openCastBox = async (
  key: Key,
  boxJson: string | undefined,
  walletId: string,
  roundId: string,
): Promise<CastBox> => {
  if (!boxJson) {
    return { v: 1, walletId, roundId, casts: {} };
  }
  const opened = await key.unseal(Box.fromJson(JSON.parse(boxJson)));
  if (!opened) {
    throw new Error('failed to decrypt the stored votes (tamper or wrong key)');
  }
  const parsed = JSON.parse(opened) as CastBox;
  if (parsed.walletId !== walletId || parsed.roundId !== roundId || !parsed.casts) {
    throw new Error('stored votes identity mismatch - blob relocated across keys');
  }
  for (const [pid, c] of Object.entries(parsed.casts)) {
    if (String(c.proposalId) !== pid || typeof c.commitmentBundleJson !== 'string') {
      throw new Error('stored vote malformed');
    }
  }
  return parsed;
};

/** Read-modify-write the round's box under the lock. */
const updateCastBox = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  change: (casts: Record<string, VoteCastRecord>) => void,
): Promise<void> =>
  castsLocked(async () => {
    const key = await sessionKey(session);
    const k = await castBoxKey(walletId, roundId);
    const storage = await getCastStorage(local);
    const box = await openCastBox(key, storage[k], walletId, roundId);
    change(box.casts);
    if (Object.keys(box.casts).length) {
      storage[k] = JSON.stringify((await key.seal(JSON.stringify(box))).toJson());
    } else {
      delete storage[k];
    }
    await (local as any).set(CASTS, storage);
  });

/** Thrown by saveVoteCast `{ create: true }` when a cast is already stored. */
export class VoteCastExists extends Error {
  constructor(proposalId: number) {
    super(`a vote on proposal ${proposalId} is already stored; resume it instead`);
  }
}

const saveVoteCastUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  cast: VoteCastRecord,
  { create = false } = {},
): Promise<void> =>
  updateCastBox(local, session, walletId, roundId, casts => {
    if (create && casts[cast.proposalId]) {
      // never overwrite a sealed bundle
      throw new VoteCastExists(cast.proposalId);
    }
    casts[cast.proposalId] = cast;
  });

const loadVoteCastUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  proposalId: number,
): Promise<VoteCastRecord | null> => {
  const key = await sessionKey(session);
  const k = await castBoxKey(walletId, roundId);
  const box = await openCastBox(key, (await getCastStorage(local))[k], walletId, roundId);
  return box.casts[proposalId] ?? null;
};

const deleteVoteCastUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  proposalId: number,
): Promise<void> =>
  updateCastBox(local, session, walletId, roundId, casts => {
    delete casts[proposalId];
  });

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
  const k = await castBoxKey(walletId, roundId);
  await castsLocked(async () => {
    const casts = await getCastStorage(local);
    delete casts[k];
    await (local as any).set(CASTS, casts);
  });
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
/** Drop one cast's record (refusal confirmed by two operators, or done with). */
export const deleteVoteCast: typeof deleteVoteCastUnlocked = (...a) =>
  keyUse(() => deleteVoteCastUnlocked(...a));
