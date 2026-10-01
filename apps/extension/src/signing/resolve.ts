/**
 * The resolver: one place a wallet kind picks its signer. Callers hand in
 * every implementation they have and get back exactly one of them - never an
 * `if (zigner) ... else if (ledger)` chain of their own. A refused kind gets a
 * signer that rejects without calling any implementation, so a watch-only or
 * unknown wallet never reaches a seed, a device or a worker.
 */

import { isPopup } from '../utils/popup-detection';
import { CAPS, type SendFlags, type WalletKind, type ZcashArm } from './wallet-kind';

export const zcashSignerFor = <T>(
  kind: WalletKind,
  flags: SendFlags,
  arms: Record<ZcashArm, () => Promise<T>>,
): (() => Promise<T>) => {
  const arm = CAPS[kind].zcash(flags);
  return typeof arm === 'string'
    ? arms[arm]
    : () => Promise.reject(new Error(`${arm.title} · ${arm.body}`));
};

/** Filter: WebHID needs a live user gesture in a document that survives the
 *  transfer. The toolbar popup is torn down on blur (and the device picker
 *  steals focus), so refuse up front instead of failing halfway. */
export const persistentSurface =
  <T>(next: () => Promise<T>) =>
  (): Promise<T> =>
    isPopup()
      ? Promise.reject(
          new Error(
            'please open zafu in a tab or the side panel to sign with a ledger · the toolbar popup closes when the device asks for focus',
          ),
        )
      : next();
