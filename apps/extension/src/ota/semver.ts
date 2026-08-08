/**
 * Canonical numeric component-wise semver compare (spec §7.1, NORMATIVE).
 *
 * Only major.minor.patch numeric components are compared. `v` prefixes,
 * prerelease/build suffixes, and any other malformed version return `null`
 * (treated as invalid / fail-closed). There is NO lexicographic/locale compare.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a version string into its three numeric components.
 *
 * @returns [major, minor, patch] or null if the string is not a clean
 *          `major.minor.patch` (rejects `v` prefixes, prerelease, build, etc).
 */
export function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | null {
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
    return null;
  }
  const m = SEMVER_RE.exec(version);
  if (!m) {
    return null;
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Compare two versions numerically component-wise.
 *
 * @returns -1 if a < b, 0 if equal, 1 if a > b, or null if either is invalid.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    return null;
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] < pb[key]) {
      return -1;
    }
    if (pa[key] > pb[key]) {
      return 1;
    }
  }
  return 0;
}

/** True when `version` is a valid canonical semver string. */
export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null;
}
