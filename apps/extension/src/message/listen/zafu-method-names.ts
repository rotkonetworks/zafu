/**
 * The zafu_* method names the wallet's three external listeners own, split by
 * listener. This is a dependency-free leaf module (no popup, no storage, no
 * chrome side effects at import) so the @zafu/protocol contract test can import
 * the REAL runtime values the dispatch uses without booting the whole
 * background. Each listener imports its names from here, so these constants are
 * the single source of truth - not a copy maintained for the test.
 *
 * Public methods here must stay in lockstep with @zafu/protocol's
 * ZAFU_V1_METHODS; the contract test (zafu-protocol-contract.test.ts) fails if
 * they drift.
 */

/** sign-request.ts - the "login with zafu" identity signature. */
export const SIGN_REQUEST_TYPE = 'zafu_sign';

/** external-encryption.ts - the public sealed-box + zid-pubkey methods. */
export const ENCRYPTION_PUBLIC_METHODS = [
  'zafu_encrypt',
  'zafu_decrypt',
  'zafu_zid_pubkey',
] as const;

/** external-encryption.ts - internal popup->worker callbacks (not dapp-facing). */
export const ENCRYPTION_INTERNAL_METHODS = ['zafu_encryption_approval_result'] as const;

/** external-easteregg.ts - the v1 methods it routes to a real handler here. */
export const EASTEREGG_V1_METHODS = [
  'ping',
  'zafu_request_capability',
  'zafu_pick_contacts',
] as const;
