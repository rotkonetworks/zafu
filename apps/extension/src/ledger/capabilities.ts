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
 *   - transparent  (signTransaction, legacy path)      : CURRENT released app.
 *                    -> "sweep Ledger transparent ZEC into a shielded wallet".
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

export interface LedgerCapabilities {
  /** the connected app version (raw), e.g. "3.6.0". */
  appVersion: string;
  /** transparent signing (t->t, t->z sweep). Assumed on any Zcash app. */
  transparent: boolean;
  /** UFVK export + orchard PCZT signing (hold/spend shielded). >= 3.8.0. */
  shielded: boolean;
}

/** Derive what the connected Ledger app can do from its version. */
export function ledgerCapabilities(appVersion: string): LedgerCapabilities {
  return {
    appVersion,
    transparent: true,
    shielded: versionAtLeast(appVersion, MIN_SHIELDED_APP_VERSION),
  };
}
