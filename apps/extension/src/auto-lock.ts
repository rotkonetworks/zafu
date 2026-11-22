/**
 * Idle auto-lock, without reloading the extension.
 *
 * It used to end with `chrome.runtime.reload()`. That wiped everything, and it
 * also cut every open tab's content scripts off from zafu until that tab was
 * reloaded: a site left open past the lock could not reach zafu's passkey (the
 * browser answered "no passkey"), nor its connection. Locking now does what
 * the reload was for, and leaves the tabs attached:
 *  - the session keys are removed (the caller does that first);
 *  - the offscreen document is closed, which ends the zcash worker, the
 *    provers and the nym tunnel with whatever they derived from the phrase;
 *  - this worker's own keyring goes to locked;
 *  - every open zafu page starts over, at its unlock (`followAutoLock`).
 */

import { isValidInternalSender } from './senders/internal';

const AUTO_LOCKED = 'zafu_auto_locked';

/** the worker's half: call after the session keys are gone */
export const lockInPlace = async (): Promise<void> => {
  await chrome.offscreen?.closeDocument().catch(() => undefined);
  const { useStore } = await import('./state');
  useStore.getState().keyRing.lock();
  // no zafu page open is the usual case, and not an error
  await chrome.runtime.sendMessage({ type: AUTO_LOCKED }).catch(() => undefined);
};

/** a zafu page's half: reload, which lands on the unlock and drops what this page had read */
export const followAutoLock = (): void => {
  chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
    if ((msg as { type?: unknown } | null)?.type === AUTO_LOCKED && isValidInternalSender(sender)) {
      window.location.reload();
    }
    return false;
  });
};
