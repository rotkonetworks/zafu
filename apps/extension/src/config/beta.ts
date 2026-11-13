/**
 * Beta features: what is built but not yet proven on real devices or with
 * real counterparties (Ledger shielded signing, the in-wallet buy). On by
 * default in the beta build, off in prod, and a switch in settings in both.
 * Plain local storage, so every page and the worker read it unlocked; it
 * rides the settings backup.
 */

import { useSyncExternalStore } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { IS_BETA_BUILD } from './feature-flags';

/** the person's choice when they made one, else the build's */
export const betaOn = (stored: unknown): boolean =>
  typeof stored === 'boolean' ? stored : IS_BETA_BUILD;

let on = IS_BETA_BUILD;
const listeners = new Set<() => void>();
const apply = (stored: unknown) => {
  const next = betaOn(stored);
  if (next !== on) {
    on = next;
    listeners.forEach(l => l());
  }
};

try {
  void localExtStorage.get('betaFeatures').then(apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'betaFeatures' in changes) {
      apply(changes['betaFeatures']?.newValue);
    }
  });
} catch {
  // no extension storage (tests): the build's default stands
}

/** for event handlers: the setting as last read */
export const betaFeatures = (): boolean => on;

/** for screens: re-renders when the setting changes */
export const useBetaFeatures = (): boolean =>
  useSyncExternalStore(
    l => (listeners.add(l), () => listeners.delete(l)),
    () => on,
  );

export const setBetaFeatures = (next: boolean): Promise<void> =>
  localExtStorage.set('betaFeatures', next);
