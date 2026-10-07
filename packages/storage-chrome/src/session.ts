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
  /**
   * the one unlock a swap's legs share: the swap it was given for, until
   * when, and how many legs it still signs. removed with signGraceUntil, and
   * when the swap's last leg is sent.
   */
  swapUnlock?: { id: string; until: number; legs?: number };
  /**
   * The key a password change just replaced, for a minute: a context still
   * holding wallet records from before the change writes their old-key inner
   * boxes back, and encrypted writes move them to the current key. Removed
   * with passwordKey.
   */
  retiredPasswordKey?: { key: KeyJson; until: number };
  /**
   * per wallet (vault id), the identity node passkeys and passwords derive
   * from, so they never decrypt the phrase. Cannot reach a spending key.
   * Removed with passwordKey.
   */
  identityKeys?: Record<string, string>;
  /** the last penumbra DEX price pass (prices per quote, then per asset id), with when it ran */
  penumbraPrices?: { at: number; book: Record<'usd' | 'um', Record<string, number | null>> };
};

// Meant to be used for short-term persisted data. Holds data in memory for the duration of a browser session.
export const sessionExtStorage = new ExtensionStorage<SessionStorageState>(
  chrome.storage.session,
  {}, // no defaults
  undefined,
);

export type SessionStorage = ExtensionStorage<SessionStorageState, undefined>;
