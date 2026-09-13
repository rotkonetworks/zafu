/**
 * Decoy cover for live zcash.me lookups.
 *
 * The public lookup endpoint is exact-match: one username per request, and
 * a hit returns 200 while a miss returns 404. So a decoy is only cover if
 * it is a REAL username that also returns 200 - a random string 404s and
 * stands out as noise, leaving the single 200 as the answer. Decoys are
 * therefore drawn from the local directory snapshot.
 *
 * The wallet controls every query, so the real lookup is made
 * indistinguishable from its decoys by construction: all k are fired in one
 * burst on the explicit lookup action (never per keystroke, which would
 * leak the prefix trail), the real name's position is randomised, and the
 * real response is not cancelled early. zcash.me sees k real names at once
 * and, since it never observes the resulting shielded payment, cannot tell
 * which one was the target within that single lookup.
 *
 * What this does NOT defend against: an adversary who correlates ACROSS
 * lookups. Resolve the same name on two days and it is the name present in
 * both decoy sets. For that, use directory mode (no per-name query at all)
 * or ZNS. Decoys are a k-anonymity band-aid for live mode, not a substitute.
 */

import type { DirectoryIndex } from './directory';
import { usernameKey } from './api';

/** hard ceiling: this is cover traffic to a small service, not a flood */
export const MAX_DECOYS = 8;

/** crypto-backed float in [0, 1) */
const cryptoUnit = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;

/**
 * The band the per-lookup decoy count is drawn from, centred on the
 * configured target. Randomising the count varies the burst size so the
 * on-wire pattern is not a fixed "k names every time" tell. A target of 0
 * disables cover (range 0..0).
 */
export const decoyCountRange = (target: number): { min: number; max: number } => {
  const t = Math.max(0, Math.min(Math.trunc(target), MAX_DECOYS));
  if (t === 0) {
    return { min: 0, max: 0 };
  }
  const spread = Math.max(1, Math.round(t / 2));
  return { min: Math.max(1, t - spread), max: Math.min(MAX_DECOYS, t + spread) };
};

/** pick a per-lookup decoy count uniformly within `decoyCountRange(target)` */
export const pickDecoyCount = (target: number, rng: () => number = cryptoUnit): number => {
  const { min, max } = decoyCountRange(target);
  if (max === 0) {
    return 0;
  }
  return min + Math.floor(rng() * (max - min + 1));
};

/** unbiased Fisher-Yates over a crypto RNG */
const shuffle = <T>(arr: T[]): T[] => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
};

/**
 * Pick up to `count` real usernames from the snapshot to accompany a live
 * lookup of `realHandle`. Excludes the real name (case-insensitive) and
 * de-dupes by canonical key. Returns fewer than `count` only when the
 * snapshot is too small - the caller decides whether that is enough cover.
 */
export const pickDecoys = (index: DirectoryIndex, realHandle: string, count: number): string[] => {
  const want = Math.max(0, Math.min(count, MAX_DECOYS));
  if (want === 0) {
    return [];
  }
  const realKey = usernameKey(realHandle);
  const pool: string[] = [];
  const seen = new Set<string>([realKey]);
  for (const p of index.byName.values()) {
    const key = usernameKey(p.username);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pool.push(p.username);
  }
  return shuffle(pool).slice(0, want);
};
