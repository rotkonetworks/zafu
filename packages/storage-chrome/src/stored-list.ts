/**
 * Reading storage another build wrote.
 *
 * Storage is shared across builds in both directions: an update reads what
 * an older build left, and a downgrade (a beta tried and rolled back, an MV3
 * worker still on the old build while a page runs the new one) reads what a
 * newer build left. `ExtensionStorage` skips migration for a newer stored
 * version (see base.ts), so readers get that newer shape as it is. The
 * policy for every reader:
 *
 * 1. A key or field may be missing. `get()` fills in the declared default
 *    only when the key is absent; a stored `null`, a sealed `{ encrypted }`
 *    box, or an object where a list was expected comes back as it is.
 * 2. Never call `.length`, `.map` or `.includes` on a stored list (or a list
 *    inside a stored record) without checking it is an array. For display and
 *    lookups, read it through `storedList`.
 * 3. Keep what you do not understand. Normalise by spreading the record and
 *    filling the one field you need, so unknown fields ride along to the next
 *    write.
 * 4. Never turn something you could not read into `[]` and write it back:
 *    that wipes another build's data (or a sealed list read while locked).
 *    A read-modify-write over a value of the wrong shape skips the write.
 */

/** the stored value as a list, or an empty one when it is missing or not a list */
export const storedList = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** whether a stored value can be read as a list (gate a read-modify-write on it) */
export const isStoredList = (value: unknown): value is unknown[] => Array.isArray(value);
