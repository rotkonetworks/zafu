/**
 * Ledger Zcash app capability model - "current app in, ready for future app".
 *
 * We connect to whatever app-zcash version is installed and light up flows by
 * what that version supports, decided from the `getAppConfig()` version read at
 * connect time. One version check, one capability object; the UI and the signer
 * filters both consult it. This is the single source of truth - the signer
 * (signing/ledger-signer.ts) imports `versionAtLeast` / `MIN_SHIELDED_APP_VERSION`
 * from here rather than redefining them.
 *
 * Capability matrix:
 *   - transparent  (signTransaction, legacy path)      : any app version, BUT
 *                    gated on the consensus branch id in force at the target
 *                    height - see `transparentSigningSupport` below.
 *   - shielded     (getShieldedAddress + UFVK export +  : app-zcash >= 3.8.0
 *                    signPcztTransaction orchard)          (unreleased).
 *                    -> hold shielded on Ledger; migrate existing shielded funds.
 */

/** Minimum app-zcash version that exposes UFVK export + orchard PCZT signing. */
export const MIN_SHIELDED_APP_VERSION = '3.8.0';

/** `true` iff dotted-numeric `version` >= `min` (missing/unparsable parts -> 0; a
 *  fully-unparsable version is treated as too old, i.e. conservative). */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => v.split('.').map(n => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(min)];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x > y;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// consensus branch id gate
// ---------------------------------------------------------------------------
//
// The legacy transparent path commits to a consensus branch id, and
// @ledgerhq/device-signer-kit-zcash picks it from `blockHeight` with its own
// hardcoded activation table (`getZcashBranchId`). The device then validates it
// through the `zcash_protocol` crate it vendors - app-zcash 3.6.0 vendors
// 0.9.0, whose `BranchId::try_from` knows nothing past NU6.2.
//
// So at current mainnet height the signer kit sends NU6.3 (0x37a5165b) and the
// app rejects the very first APDU of the flow with 6a80. Device-verified on
// Speculos (nanosp, app-zcash 3.6.0): NU6.3 -> 6a80 on GET_TRUSTED_INPUT,
// NU6.2 -> 9000 and the flow completes to a signature.
//
// This is a hard blocker, not a warning: with `blockHeight` at or past NU6.3
// activation - AND with `blockHeight` left undefined, which the signer kit also
// maps to NU6.3 - no released app can sign a transparent transaction.

/** Activation heights, mirroring signer-kit 0.5.0's `getZcashBranchId` table. */
export const NETWORK_UPGRADE_ACTIVATION = {
  'nu6.3': 3428143,
  'nu6.2': 3364600,
  'nu6.1': 3146400,
  nu6: 2726400,
  nu5: 1687104,
  canopy: 1046400,
  heartwood: 903000,
  blossom: 653600,
  sapling: 419200,
} as const;

export type NetworkUpgradeName = keyof typeof NETWORK_UPGRADE_ACTIVATION | 'overwinter';

/** Consensus branch ids (ZIP 200), the same values the signer kit sends. */
export const CONSENSUS_BRANCH_ID: Record<NetworkUpgradeName, number> = {
  'nu6.3': 0x37a5165b,
  'nu6.2': 0x5437f330,
  'nu6.1': 0x4dec4df0,
  nu6: 0xc8e71055,
  nu5: 0xc2d6d0b4,
  canopy: 0xe9ff75a6,
  heartwood: 0xf5b9230b,
  blossom: 0x2bb40e60,
  sapling: 0x76b809bb,
  overwinter: 0x5ba81b19,
};

/** Upgrades newest-first, for the height lookup. */
const UPGRADES_NEWEST_FIRST = [
  'nu6.3',
  'nu6.2',
  'nu6.1',
  'nu6',
  'nu5',
  'canopy',
  'heartwood',
  'blossom',
  'sapling',
] as const;

/**
 * Which upgrade the signer kit will pick for `blockHeight`.
 *
 * `undefined` deliberately resolves to the newest upgrade: that is what
 * `getZcashBranchId(null | undefined)` does, so treating "unknown height" as
 * anything softer would under-report the failure.
 */
export function branchForHeight(blockHeight?: number): NetworkUpgradeName {
  if (blockHeight === undefined) {
    return 'nu6.3';
  }
  for (const name of UPGRADES_NEWEST_FIRST) {
    if (blockHeight >= NETWORK_UPGRADE_ACTIVATION[name]) {
      return name;
    }
  }
  return 'overwinter';
}

/**
 * Minimum app-zcash version that accepts each branch id.
 *
 * `'0.0.0'` = every published app version accepts it (verified against 3.6.0,
 * which vendors zcash_protocol 0.9.0).
 *
 * `null` = NO published app version accepts it. The highest public tag is
 * 3.6.0, and app-zcash publishes no release ELFs, so this cannot be softened by
 * hoping. When a release is verified against Speculos to accept the branch id,
 * put its version here and re-run `transparent.test.ts`.
 */
export const BRANCH_ID_MIN_APP_VERSION: Record<NetworkUpgradeName, string | null> = {
  'nu6.3': null,
  'nu6.2': '0.0.0',
  'nu6.1': '0.0.0',
  nu6: '0.0.0',
  nu5: '0.0.0',
  canopy: '0.0.0',
  heartwood: '0.0.0',
  blossom: '0.0.0',
  sapling: '0.0.0',
  overwinter: '0.0.0',
};

// ---------------------------------------------------------------------------
// signer-kit <-> app incompatibilities
// ---------------------------------------------------------------------------
//
// Two more blockers sit between @ledgerhq/device-signer-kit-zcash 0.5.0 and
// app-zcash 3.6.0. Neither is fixable from our side - both live inside the
// SDK's own `SignTransactionTask` - so the transparent path fails closed until
// a signer-kit release fixes them. Both are device-verified on Speculos.

/** The signer-kit release these observations were made against. */
export const SIGNER_KIT_VERSION_VERIFIED = '0.5.0';

/**
 * `false`: signer-kit 0.5.0's `SignTransactionCommand` packs the signing path
 * AND the lockTime / sigHashType / expiryHeight extra header into ONE SIGN
 * (0x48) APDU. app-zcash wants them as two: an 11-byte extra-header frame with
 * an empty path first ("not used path size 1 + not used auth len 1 + locktime 4
 * + sighash 1 + expiry 4"), then the path. The combined 31-byte frame is
 * rejected 6700 (WrongApduLength) - verified on Speculos against 3.6.0.
 */
export const SIGNER_KIT_SIGN_APDU_COMPATIBLE = false;

/**
 * `false`: app-zcash 3.6.0's transparent sighash does NOT cover the expiry
 * height (or lockTime) the SIGN APDU carries. `parse_input_script` computes the
 * signature digest at the end of the input replay, before `handler_hash_sign`
 * ever sees those bytes, so the header digest always commits to expiry 0 and
 * lockTime 0. Verified on Speculos: changing an output value changes the
 * signature, changing the expiry or lockTime bytes does not.
 *
 * Consequence: a transaction serialized with a real expiry height would carry a
 * signature that does not commit to it. We refuse rather than ship that.
 */
export const APP_COMMITS_TO_EXPIRY_HEIGHT = false;

export interface TransparentSigningSupport {
  /** can this app version sign a transparent tx at this height? */
  readonly supported: boolean;
  /** the upgrade whose branch id the signer kit will send */
  readonly branch: NetworkUpgradeName;
  /** the branch id itself, as the device will see it */
  readonly branchId: number;
  /** every reason it cannot, most specific first */
  readonly blockers: readonly string[];
  /** the first blocker - safe to show to a user */
  readonly reason?: string;
}

/** Can `appVersion` sign a transparent transaction at `blockHeight`? */
export function transparentSigningSupport(
  appVersion: string,
  blockHeight?: number,
): TransparentSigningSupport {
  const branch = branchForHeight(blockHeight);
  const branchId = CONSENSUS_BRANCH_ID[branch];
  const min = BRANCH_ID_MIN_APP_VERSION[branch];
  const hex = `0x${branchId.toString(16).padStart(8, '0')}`;
  const blockers: string[] = [];

  if (min === null) {
    blockers.push(
      `${branch} consensus branch id ${hex} is not recognised by any released ` +
        `app-zcash (latest is 3.6.0, installed ${appVersion}) - the device rejects ` +
        `the first APDU with 6a80`,
    );
  } else if (!versionAtLeast(appVersion, min)) {
    blockers.push(
      `ledger zcash app ${appVersion} < ${min}: it does not recognise the ${branch} ` +
        `consensus branch id ${hex}`,
    );
  }

  if (!SIGNER_KIT_SIGN_APDU_COMPATIBLE) {
    blockers.push(
      `@ledgerhq/device-signer-kit-zcash ${SIGNER_KIT_VERSION_VERIFIED} sends the ` +
        `signing path and the lockTime/sigHashType/expiry header in one SIGN apdu; ` +
        `app-zcash ${appVersion} requires two and rejects the combined frame with 6700`,
    );
  }

  return {
    supported: blockers.length === 0,
    branch,
    branchId,
    blockers,
    reason: blockers[0],
  };
}

export interface LedgerCapabilities {
  /** the connected app version (raw), e.g. "3.6.0". */
  appVersion: string;
  /** transparent signing (t->t, t->z sweep) at `blockHeight`. */
  transparent: boolean;
  /** why `transparent` is false, when it is. */
  transparentReason?: string;
  /** UFVK export + orchard PCZT signing (hold/spend shielded). >= 3.8.0. */
  shielded: boolean;
}

/**
 * Derive what the connected Ledger app can do.
 *
 * `blockHeight` is the height the transaction would be built against. Omitting
 * it is NOT a way to skip the check: an unknown height resolves to the newest
 * upgrade, exactly as the signer kit does.
 */
export function ledgerCapabilities(appVersion: string, blockHeight?: number): LedgerCapabilities {
  const transparent = transparentSigningSupport(appVersion, blockHeight);
  return {
    appVersion,
    transparent: transparent.supported,
    transparentReason: transparent.reason,
    shielded: versionAtLeast(appVersion, MIN_SHIELDED_APP_VERSION),
  };
}
