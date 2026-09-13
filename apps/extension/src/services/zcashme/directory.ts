/**
 * Local copy of the zcash.me directory.
 *
 * A snapshot is a plain list of public profiles - the same bytes for
 * every user - so it lives unencrypted in chrome.storage.local. It is NOT
 * an address book: nothing in it says which names this user cares about.
 * (Contacts, which do, stay in the encrypted contacts store.)
 *
 * Two ways to obtain one:
 *   - pull it from zcash.me directly with a user-supplied api key
 *   - download a pre-built snapshot json from a mirror url (a server that
 *     holds the key and republishes the directory on a schedule)
 *
 * Both produce the same `DirectorySnapshot`, and everything downstream
 * (picker autocomplete, counterparty labels, save-contact prefill) reads
 * the in-memory index built from it. Index lookups are synchronous so
 * they can sit inside `useMemo` next to `contacts.findByAddress`.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { fetchDirectoryAll, usernameKey, type ZcashMeProfile } from './api';

export const DIRECTORY_SNAPSHOT_VERSION = 1 as const;

export interface DirectorySnapshot {
  version: typeof DIRECTORY_SNAPSHOT_VERSION;
  /** unix ms when the snapshot was produced */
  fetchedAt: number;
  /** where it came from - 'api' (own key) or the mirror url */
  source: string;
  profiles: ZcashMeProfile[];
}

export interface DirectoryIndex {
  snapshot: DirectorySnapshot;
  byName: Map<string, ZcashMeProfile>;
  byAddress: Map<string, ZcashMeProfile>;
}

const SNAPSHOT_FETCH_TIMEOUT_MS = 30_000;

const isProfile = (v: unknown): v is ZcashMeProfile => {
  if (!v || typeof v !== 'object') {
    return false;
  }
  const p = v as Partial<ZcashMeProfile>;
  return (
    typeof p.username === 'string' &&
    typeof p.address === 'string' &&
    typeof p.addressVerified === 'boolean' &&
    Array.isArray(p.links)
  );
};

/** validate a snapshot fetched from a mirror; never trust the shape blindly */
export const parseDirectorySnapshot = (raw: unknown, source: string): DirectorySnapshot => {
  if (!raw || typeof raw !== 'object') {
    throw new Error('snapshot is not an object');
  }
  const s = raw as Partial<DirectorySnapshot>;
  if (s.version !== DIRECTORY_SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version ${String(s.version)}`);
  }
  if (!Array.isArray(s.profiles)) {
    throw new Error('snapshot has no profiles array');
  }
  const profiles = s.profiles.filter(isProfile);
  return {
    version: DIRECTORY_SNAPSHOT_VERSION,
    fetchedAt: typeof s.fetchedAt === 'number' ? s.fetchedAt : Date.now(),
    source,
    profiles,
  };
};

/**
 * Build the lookup maps. When two profiles claim one name or address a
 * verified one wins over an unverified one; among equals the first stays,
 * which matches the server's own "lowest id wins" rule for lookup.
 */
export const buildDirectoryIndex = (snapshot: DirectorySnapshot): DirectoryIndex => {
  const byName = new Map<string, ZcashMeProfile>();
  const byAddress = new Map<string, ZcashMeProfile>();
  const put = (map: Map<string, ZcashMeProfile>, key: string, p: ZcashMeProfile) => {
    const prev = map.get(key);
    if (!prev || (!prev.addressVerified && p.addressVerified)) {
      map.set(key, p);
    }
  };
  for (const p of snapshot.profiles) {
    put(byName, usernameKey(p.username), p);
    put(byAddress, p.address, p);
  }
  return { snapshot, byName, byAddress };
};

/**
 * Substring search over usernames and display names, ranked like the
 * server does it: username prefix, username contains, display prefix,
 * display contains. Verified profiles sort ahead within a tier.
 */
export const searchDirectory = (
  index: DirectoryIndex,
  query: string,
  limit: number,
): ZcashMeProfile[] => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }
  const tier = (p: ZcashMeProfile): number => {
    const u = p.username.toLowerCase();
    const d = (p.displayName ?? '').toLowerCase();
    if (u.startsWith(q)) {
      return 0;
    }
    if (u.includes(q)) {
      return 1;
    }
    if (d.startsWith(q)) {
      return 2;
    }
    if (d.includes(q)) {
      return 3;
    }
    return -1;
  };
  const hits: { p: ZcashMeProfile; t: number }[] = [];
  for (const p of index.byName.values()) {
    const t = tier(p);
    if (t >= 0) {
      hits.push({ p, t });
    }
  }
  hits.sort(
    (a, b) =>
      a.t - b.t ||
      Number(b.p.addressVerified) - Number(a.p.addressVerified) ||
      a.p.username.localeCompare(b.p.username),
  );
  return hits.slice(0, limit).map(h => h.p);
};

// ---------------------------------------------------------------------------
// persistence + module-level index
// ---------------------------------------------------------------------------

let current: DirectoryIndex | null = null;
let loading: Promise<DirectoryIndex | null> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) {
    l();
  }
};

/** subscribe to index replacement (used by the react hook) */
export const onDirectoryChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** synchronous read of whatever is loaded; null until `loadDirectoryIndex` ran */
export const getDirectoryIndex = (): DirectoryIndex | null => current;

/** load the persisted snapshot into memory once; safe to call repeatedly */
export const loadDirectoryIndex = (): Promise<DirectoryIndex | null> => {
  if (current) {
    return Promise.resolve(current);
  }
  if (!loading) {
    loading = localExtStorage
      .get('zcashMeDirectory')
      .then(stored => {
        if (stored) {
          try {
            current = buildDirectoryIndex(parseDirectorySnapshot(stored, stored.source));
            notify();
          } catch {
            current = null;
          }
        }
        return current;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
};

export const saveDirectorySnapshot = async (
  snapshot: DirectorySnapshot,
): Promise<DirectoryIndex> => {
  await localExtStorage.set('zcashMeDirectory', snapshot);
  current = buildDirectoryIndex(snapshot);
  notify();
  return current;
};

export const clearDirectorySnapshot = async (): Promise<void> => {
  await localExtStorage.remove('zcashMeDirectory');
  current = null;
  notify();
};

/** counterparty label: address -> profile, local only, never hits the network */
export const directoryProfileByAddress = (
  address: string | undefined,
): ZcashMeProfile | undefined => (address ? current?.byAddress.get(address) : undefined);

/** name -> profile, local only */
export const directoryProfileByName = (username: string): ZcashMeProfile | undefined =>
  current?.byName.get(usernameKey(username));

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

export interface DirectoryRefreshOptions {
  fetch?: typeof fetch;
  onProgress?: (p: { pages: number; profiles: number }) => void;
}

/** pull the whole directory with the user's own api key */
export const refreshDirectoryFromApi = async (
  apiKey: string,
  opts: DirectoryRefreshOptions = {},
): Promise<DirectoryIndex> => {
  const profiles = await fetchDirectoryAll({
    apiKey,
    fetch: opts.fetch,
    onProgress: opts.onProgress,
  });
  return saveDirectorySnapshot({
    version: DIRECTORY_SNAPSHOT_VERSION,
    fetchedAt: Date.now(),
    source: 'api',
    profiles,
  });
};

/** download a pre-built snapshot json from a mirror */
export const refreshDirectoryFromMirror = async (
  url: string,
  opts: DirectoryRefreshOptions = {},
): Promise<DirectoryIndex> => {
  const doFetch = opts.fetch ?? fetch;
  const trimmed = url.trim();
  const isLocalDev =
    trimmed.startsWith('http://localhost') || trimmed.startsWith('http://127.0.0.1');
  if (!trimmed.startsWith('https://') && !isLocalDev) {
    throw new Error('snapshot mirror must be https (or localhost for dev)');
  }
  const resp = await doFetch(trimmed, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${new URL(trimmed).host}`);
  }
  const snapshot = parseDirectorySnapshot(await resp.json(), trimmed);
  return saveDirectorySnapshot(snapshot);
};
