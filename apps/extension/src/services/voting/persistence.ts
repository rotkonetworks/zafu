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

/**
 * One round's hotkey record at rest: the whole record (which wallet, which
 * round, when, the pubkey, the secret and the delegation state) in ONE
 * identity-bound sealed box, under a hashed key, as the casts are. Storage
 * shows neither which rounds a wallet joined nor when.
 */
interface HotkeyBox {
  v: 2;
  walletId: string;
  roundId: string;
  secret: string;
  pubkey: string;
  state: string | null;
  createdAt: number;
}

/** the record as older builds stored it: wallet, round and time in the clear */
interface LegacyVotingRecord {
  roundId: string;
  walletId: string;
  hotkeySecretBox: string;
  hotkeyPubkeyHex: string;
  delegationStateBox: string | null;
  createdAt: number;
}

const HOTKEYS = 'votingHotkeys';
const HOTKEYS_LOCK = 'zafu-voting-hotkeys';

/** Every read-modify-write of votingHotkeys runs under this one Web Lock. */
const hotkeysLocked = <T>(fn: () => Promise<T>): Promise<T> =>
  navigator.locks.request(HOTKEYS_LOCK, { mode: 'exclusive' }, fn) as Promise<T>;

const hotkeyBoxKey = async (walletId: string, roundId: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`zafu-voting-hotkeys:v2:${walletId}:${roundId}`),
  );
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

type HotkeyStorage = Record<string, string | LegacyVotingRecord>;

const getVotingStorage = async (local: ExtensionStorage<LocalStorageState>): Promise<HotkeyStorage> =>
  // votingHotkeys is not in the schema (like votingCasts)
  ((await (local as any).get(HOTKEYS)) as HotkeyStorage | undefined) ?? {};

const setVotingStorage = async (
  local: ExtensionStorage<LocalStorageState>,
  storage: HotkeyStorage,
): Promise<void> => {
  await (local as any).set(HOTKEYS, storage);
};

/**
 * Open an identity-bound sealed value and check it names `walletId`/`roundId`.
 * Fail-closed: any decrypt, parse or identity failure throws.
 */
const unsealBound = async <T extends { walletId: string; roundId: string }>(
  key: Key,
  boxJson: string,
  walletId: string,
  roundId: string,
  label: string,
): Promise<T> => {
  const decrypted = await key.unseal(Box.fromJson(JSON.parse(boxJson)));
  if (!decrypted) {
    throw new Error(`failed to decrypt voting ${label} (tamper or wrong key)`);
  }
  const parsed = JSON.parse(decrypted) as T;
  if (parsed.walletId !== walletId || parsed.roundId !== roundId) {
    throw new Error(`voting ${label} identity mismatch - blob relocated across keys`);
  }
  return parsed;
};

/** a legacy record, opened (its boxes were identity-bound too) */
const openLegacy = async (
  key: Key,
  r: LegacyVotingRecord,
  walletId: string,
  roundId: string,
): Promise<HotkeyBox> => {
  if (!r.hotkeySecretBox) {
    throw new Error('voting round record has no hotkey - corrupt or partial record');
  }
  const secret = (
    await unsealBound<{ walletId: string; roundId: string; secret?: string }>(
      key,
      r.hotkeySecretBox,
      walletId,
      roundId,
      'hotkey',
    )
  ).secret;
  const state = r.delegationStateBox
    ? (
        await unsealBound<{ walletId: string; roundId: string; state?: string }>(
          key,
          r.delegationStateBox,
          walletId,
          roundId,
          'delegation state',
        )
      ).state
    : null;
  if (typeof secret !== 'string' || (state !== null && typeof state !== 'string')) {
    throw new Error('voting round record malformed');
  }
  return {
    v: 2,
    walletId,
    roundId,
    secret,
    pubkey: r.hotkeyPubkeyHex,
    state: state ?? null,
    createdAt: r.createdAt,
  };
};

/** the round's record, from its sealed box or a legacy entry; undefined when there is none */
const readHotkeyBox = async (
  key: Key,
  storage: HotkeyStorage,
  walletId: string,
  roundId: string,
): Promise<HotkeyBox | undefined> => {
  const sealed = storage[await hotkeyBoxKey(walletId, roundId)];
  if (typeof sealed === 'string') {
    const box = await unsealBound<HotkeyBox>(key, sealed, walletId, roundId, 'round record');
    if (box.v !== 2 || typeof box.secret !== 'string' || !box.secret) {
      throw new Error('voting round record has no hotkey - corrupt or partial record');
    }
    return box;
  }
  const legacy = storage[`${walletId}:${roundId}`];
  return legacy && typeof legacy === 'object'
    ? openLegacy(key, legacy, walletId, roundId)
    : undefined;
};

/** Read-modify-write one round's record under the lock; a legacy entry is resealed and dropped. */
const updateHotkeyBox = async (
  local: ExtensionStorage<LocalStorageState>,
  key: Key,
  walletId: string,
  roundId: string,
  change: (box: HotkeyBox | undefined) => HotkeyBox,
): Promise<void> =>
  hotkeysLocked(async () => {
    const storage = await getVotingStorage(local);
    const next = change(await readHotkeyBox(key, storage, walletId, roundId));
    storage[await hotkeyBoxKey(walletId, roundId)] = JSON.stringify(
      (await key.seal(JSON.stringify(next))).toJson(),
    );
    delete storage[`${walletId}:${roundId}`];
    await setVotingStorage(local, storage);
  });

const passwordKey = async (
  session: ExtensionStorage<SessionStorageState>,
  what: string,
): Promise<Key> => {
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error(`keyring locked - cannot ${what}`);
  }
  return Key.fromJson(sessionKeyJson);
};

/**
 * Save (or update) the voting hotkey for a round.
 * The hotkey secret is NEVER stored unencrypted, and neither is the fact that
 * this wallet joined this round.
 */
const saveVotingHotkeyUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  hotkeySecretHex: string,
  hotkeyPubkeyHex: string,
): Promise<void> => {
  const key = await passwordKey(session, 'save voting hotkey');
  await updateHotkeyBox(local, key, walletId, roundId, existing => ({
    v: 2,
    walletId,
    roundId,
    secret: hotkeySecretHex,
    pubkey: hotkeyPubkeyHex,
    state: existing?.state ?? null,
    createdAt: existing?.createdAt ?? Date.now(),
  }));
};

/**
 * Update the delegation state blob for a round (opaque JSON from wasm, stored
 * verbatim). The hotkey must be saved first.
 */
const saveDelegationStateUnlocked = async (
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
  walletId: string,
  roundId: string,
  delegationStateJson: string,
): Promise<void> => {
  const key = await passwordKey(session, 'save delegation state');
  await updateHotkeyBox(local, key, walletId, roundId, existing => {
    // fail-closed: delegation state must NEVER precede the hotkey - a record
    // with delegation state but an empty hotkey would cast with an empty seed
    if (!existing?.secret) {
      throw new Error(
        'cannot save delegation state before the voting hotkey for this round is persisted',
      );
    }
    return { ...existing, state: delegationStateJson };
  });
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
  const key = await passwordKey(session, 'load voting round');
  let box: HotkeyBox | undefined;
  try {
    box = await readHotkeyBox(key, await getVotingStorage(local), walletId, roundId);
  } catch (e) {
    throw new Error(`failed to load voting hotkey: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!box) {
    return null;
  }
  return {
    roundId,
    walletId,
    hotkeySecretHex: box.secret,
    hotkeyPubkeyHex: box.pubkey,
    delegationStateJson: box.state,
    createdAt: box.createdAt,
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
  const boxKey = await hotkeyBoxKey(walletId, roundId);
  await hotkeysLocked(async () => {
    const storage = await getVotingStorage(local);
    delete storage[boxKey];
    delete storage[`${walletId}:${roundId}`];
    await setVotingStorage(local, storage);
  });
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
