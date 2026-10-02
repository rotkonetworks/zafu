/**
 * What the service worker does as the first zafu window opens and the last
 * one closes: sync resumes and pauses with the windows. Nothing here opens a
 * relay connection - presence, discovery and chat wait for a user action
 * (the no-autoconnect contract).
 */

import { trackUiOpenPresence } from './state/ui-open-presence';

export interface UiOpenSession {
  /** true while some zafu window is open */
  readonly open: boolean;
}

export const startUiOpenSession = (sync: {
  resume: () => void;
  pause: () => void;
}): UiOpenSession => {
  const session = { open: false };
  trackUiOpenPresence(
    () => {
      session.open = true;
      sync.resume();
    },
    () => {
      session.open = false;
      sync.pause();
    },
  );
  return session;
};
