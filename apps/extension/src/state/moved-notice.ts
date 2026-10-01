/**
 * "a few things moved" (board StMigrate): told once, to someone who used zafu
 * before the redesign, on the first popup open after the update.
 *
 * `lastSeenVersion` is the release whose changes the person has seen: stamped
 * with the installed version on a fresh install, with the previous version on
 * the first update that finds none, and with the current one on dismissal.
 */
export const LAST_SEEN_VERSION = 'lastSeenVersion';

/** the last release with the old layout */
const LAST_BEFORE_MOVES = '28.3.1';

export const MOVED = [
  'header and tabs on every screen',
  'lock is in the accounts sheet',
  'networks live in one menu',
  'one transparent address per pocket',
] as const;

const cmpVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
};

/** whether someone who last saw `seen`, now on `current`, is told what moved */
export const showMoved = (seen: unknown, current: string) =>
  typeof seen === 'string' && seen !== current && cmpVersion(seen, LAST_BEFORE_MOVES) <= 0;

/** the service worker's half: remember which release the person came from */
export const stampSeenVersion = async (reason: string, previousVersion?: string) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ [LAST_SEEN_VERSION]: chrome.runtime.getManifest().version });
  } else if (reason === 'update' && previousVersion) {
    const seen = (await chrome.storage.local.get(LAST_SEEN_VERSION))[LAST_SEEN_VERSION];
    if (seen === undefined) {
      await chrome.storage.local.set({ [LAST_SEEN_VERSION]: previousVersion });
    }
  }
};
