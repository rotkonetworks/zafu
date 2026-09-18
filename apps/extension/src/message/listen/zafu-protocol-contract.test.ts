/**
 * Contract test: the wallet's live zafu_* handler surface must match the
 * @zafu/protocol v1 registry that the @zafu/zid SDK is written against.
 *
 * This is the anti-drift gate. Field-shape drift is already caught by tsc (the
 * handlers import their request/response types from @zafu/protocol). This test
 * covers the other half: the SET of methods. If a method is added to or removed
 * from the protocol without a matching handler change (or vice versa), the
 * parity assertion below fails.
 *
 * The v1 method names each listener owns live in the dependency-free
 * zafu-method-names leaf - the SAME runtime values the dispatch uses (the
 * listeners import their names from there). Reading them here needs no popup or
 * chrome side effects, so the test stays a pure surface check.
 */

import { describe, it, expect } from 'vitest';
import { ZAFU_V1_METHODS } from '@zafu/protocol';
import {
  SIGN_REQUEST_TYPE,
  ENCRYPTION_PUBLIC_METHODS,
  EASTEREGG_V1_METHODS,
} from './zafu-method-names';

const encryptionPublicMethods = [...ENCRYPTION_PUBLIC_METHODS];

const walletHandledMethods = new Set<string>([
  ...encryptionPublicMethods,
  SIGN_REQUEST_TYPE,
  ...EASTEREGG_V1_METHODS,
]);

describe('zafu_* wallet handlers vs @zafu/protocol v1', () => {
  it('every protocol method is handled by exactly one wallet listener', () => {
    const missing = ZAFU_V1_METHODS.filter(m => !walletHandledMethods.has(m));
    expect(missing, `protocol methods with no wallet handler: ${missing.join(', ')}`).toEqual([]);
  });

  it('no wallet-claimed v1 method is absent from the protocol', () => {
    const protocolSet = new Set<string>(ZAFU_V1_METHODS);
    const extra = [...walletHandledMethods].filter(m => !protocolSet.has(m));
    expect(extra, `wallet handles v1 methods not in @zafu/protocol: ${extra.join(', ')}`).toEqual(
      [],
    );
  });

  it('the split across the three listeners is disjoint (no double-owned method)', () => {
    const all = [...encryptionPublicMethods, SIGN_REQUEST_TYPE, ...EASTEREGG_V1_METHODS];
    expect(all.length, 'a method is owned by more than one listener').toBe(
      new Set(all).size,
    );
  });
});
