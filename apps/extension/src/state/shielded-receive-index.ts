/**
 * Zcash shielded receive addresses are single-use, and picked at random.
 *
 * `zcashShieldedDiversifier` holds the diversifier index of the address
 * currently on offer: 11 random bytes as 22 hex chars, the whole orchard index
 * space. Every screen that hands the address out (showing it on receive,
 * copying it, copying a payment link) replaces it with a fresh random one, so
 * no two senders are ever given the same string to compare.
 *
 * Random rather than a counter, as penumbra does with its address randomizer:
 * a counter lives in one browser, so restoring the seed elsewhere or running
 * two devices would walk back over addresses already handed out. 88 random
 * bits never collide in practice, and there is nothing to remember. Every
 * diversified address decrypts to the same wallet during scanning, so rotating
 * costs nothing, and orchard has no gap limit a restore could fall off.
 *
 * Orchard-only: a unified address with a transparent receiver is limited to a
 * 31-bit index. Transparent keeps its own `zcashTransparentIndex`.
 */

export const SHIELDED_DIVERSIFIER_KEY = 'zcashShieldedDiversifier';
/** the sequential counter this replaced; dropped on the first rotation */
const LEGACY_INDEX_KEY = 'zcashShieldedIndex';

const randomDiversifier = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(11)), b => b.toString(16).padStart(2, '0')).join(
    '',
  );

/** Retire the address on offer and move to a fresh one; resolves to its index. */
export const rotateShieldedDiversifier = async (): Promise<string> => {
  const next = randomDiversifier();
  await chrome.storage.local.set({ [SHIELDED_DIVERSIFIER_KEY]: next });
  await chrome.storage.local.remove(LEGACY_INDEX_KEY);
  return next;
};

/**
 * The index on offer. Reading never writes: rotation is the only writer, so a
 * read can't race a rotation into storage. With none stored yet it is a fresh
 * random index that nobody has seen; the next rotation replaces it anyway.
 */
export const readShieldedDiversifier = async (): Promise<string> => {
  const r = await chrome.storage.local.get(SHIELDED_DIVERSIFIER_KEY);
  const stored = r[SHIELDED_DIVERSIFIER_KEY] as string | undefined;
  return stored && /^[0-9a-f]{22}$/.test(stored) ? stored : randomDiversifier();
};
