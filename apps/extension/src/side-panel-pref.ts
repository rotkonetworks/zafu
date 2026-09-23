import { localExtStorage } from '@repo/storage-chrome/local';

/**
 * In-memory mirror of the `approvalsInSidePanel` preference, so the connect
 * listener can decide whether to open the side panel WITHOUT an awaited storage
 * read.
 *
 * Why this exists: `chrome.sidePanel.open()` only works when called with no
 * `await` before it in the user-gesture task (see content-script-connect). An
 * awaited `localExtStorage.get(...)` right before the open is exactly what loses
 * the gesture and forces the popup fallback. Reading a cached boolean is
 * synchronous, so the open stays inside the gesture.
 *
 * Default is `true` (side panel is the default approval surface); only an
 * explicit `false` (user chose "popup window") opts out.
 */
let cached = true;

const refresh = (): void => {
  void localExtStorage
    .get('approvalsInSidePanel')
    .then(value => {
      cached = value !== false;
    })
    .catch(() => undefined);
};

/** Call once at service-worker startup. Seeds the cache and keeps it current. */
export const initSidePanelPref = (): void => {
  refresh();
  try {
    localExtStorage.addListener(() => refresh());
  } catch {
    // storage listener unavailable - the seeded value still serves.
  }
};

/** Synchronous read of the cached preference. Never awaits. */
export const wantsSidePanelSync = (): boolean => cached;
