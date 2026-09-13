/**
 * User-facing zcash.me settings. Persisted in chrome.storage.local under
 * `zcashMeConfig`; default is OFF - nothing about zcash.me leaves the
 * wallet until the user picks a mode in settings.
 *
 *   off        no directory features at all (default)
 *   directory  answer from the local snapshot only; no per-query traffic
 *   live       resolve "/name" on demand via the public lookup endpoint;
 *              zcash.me sees your ip and the name each time
 *
 * Snapshot sources (used by `directory` mode, and by `live` mode as a
 * cache when present): a mirror url, or the user's own api key. The key
 * is the user's own and is stored like the proxy config - plain local
 * storage, never bundled, never sent anywhere but zcash.me.
 *
 * Config and index are module-level so every popup surface (tx rows,
 * inbox threads, the picker, settings) shares one storage read and
 * re-renders together when either changes.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { ZcashMeProfile } from './api';
import {
  directoryProfileByAddress,
  getDirectoryIndex,
  loadDirectoryIndex,
  onDirectoryChange,
  type DirectoryIndex,
} from './directory';

export type ZcashMeMode = 'off' | 'directory' | 'live';

export interface ZcashMeConfig {
  mode: ZcashMeMode;
  /** https url serving a `DirectorySnapshot` json; empty = none */
  mirrorUrl: string;
  /** user's own zcash.me api key for bulk directory pulls; empty = none */
  apiKey: string;
  /** user chose "not now" on an in-context offer; passive offers stop */
  promptDismissed: boolean;
  /**
   * live-mode cover: number of real decoy names (from the snapshot) fired
   * alongside each live lookup. 0 = no cover. Capped at MAX_DECOYS. Needs a
   * snapshot to draw real decoys from, so it only takes effect when one is
   * loaded.
   */
  decoys: number;
}

/** decoys seeded when a user first switches to live mode (they can change it) */
export const DEFAULT_LIVE_DECOYS = 4;

export const DEFAULT_ZCASHME_CONFIG: ZcashMeConfig = {
  mode: 'off',
  mirrorUrl: '',
  apiKey: '',
  promptDismissed: false,
  decoys: 0,
};

let cached: ZcashMeConfig | null = null;
let reading: Promise<ZcashMeConfig> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const l of listeners) {
    l();
  }
};

const onConfigChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** synchronous read of the cached config; null until the first read resolves */
export const getZcashMeConfig = (): ZcashMeConfig | null => cached;

export const readZcashMeConfig = (): Promise<ZcashMeConfig> => {
  if (cached) {
    return Promise.resolve(cached);
  }
  if (!reading) {
    reading = localExtStorage
      .get('zcashMeConfig')
      .then(stored => {
        cached = { ...DEFAULT_ZCASHME_CONFIG, ...(stored ?? {}) };
        notify();
        return cached;
      })
      .finally(() => {
        reading = null;
      });
  }
  return reading;
};

export const writeZcashMeConfig = async (config: ZcashMeConfig): Promise<void> => {
  await localExtStorage.set('zcashMeConfig', config);
  cached = config;
  notify();
};

/**
 * Make sure config and (when on) the directory index are loaded. Idempotent
 * and cheap after the first call, so any surface can invoke it on mount.
 */
export const ensureZcashMeLoaded = async (): Promise<void> => {
  const c = await readZcashMeConfig();
  if (c.mode !== 'off') {
    await loadDirectoryIndex();
  }
};

const subscribeBoth = (listener: () => void): (() => void) => {
  const a = onConfigChange(listener);
  const b = onDirectoryChange(listener);
  return () => {
    a();
    b();
  };
};

/**
 * Config + loaded directory index for components. `config` is null until
 * the first read resolves so callers can tell "off" from "not loaded yet";
 * `index` is null whenever the mode is off, whatever is cached.
 */
export const useZcashMe = (): { config: ZcashMeConfig | null; index: DirectoryIndex | null } => {
  const config = useSyncExternalStore(subscribeBoth, getZcashMeConfig);
  const index = useSyncExternalStore(subscribeBoth, getDirectoryIndex);
  useEffect(() => {
    void ensureZcashMeLoaded();
  }, [config?.mode]);
  return { config, index: config && config.mode !== 'off' ? index : null };
};

const noProfile = (): ZcashMeProfile | undefined => undefined;

/**
 * Counterparty label source for tx rows and inbox threads. Returns a
 * synchronous address -> profile function that answers from the local
 * snapshot only, and only while the mode is not off - flipping the mode to
 * off hides directory names everywhere at once. Never touches the network.
 */
export const useZcashMeDirectoryLookup = (): ((
  address: string | undefined,
) => ZcashMeProfile | undefined) => {
  const { config, index } = useZcashMe();
  return config && config.mode !== 'off' && index ? directoryProfileByAddress : noProfile;
};
