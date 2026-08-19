import { ExtensionStorage } from './base';
import type { KeyJson } from '@repo/encryption/key';

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- storage schema should be `type` and not `interface`
export type SessionStorageState = {
  passwordKey?: KeyJson;
  /**
   * epoch ms until which the per-transaction password gate is skipped under the
   * 'grace' signing-security level. lives in SESSION storage so it clears on
   * browser restart, and is explicitly removed everywhere `passwordKey` is
   * removed (auto-lock / manual lock / nuke) so grace never outlives the unlock.
   */
  signGraceUntil?: number;
};

// Meant to be used for short-term persisted data. Holds data in memory for the duration of a browser session.
export const sessionExtStorage = new ExtensionStorage<SessionStorageState>(
  chrome.storage.session,
  {}, // no defaults
  undefined,
);

export type SessionStorage = ExtensionStorage<SessionStorageState, undefined>;
