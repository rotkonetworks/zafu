/**
 * Which key filled a zcash store?
 *
 * A store is the notes one viewing key found. Nothing else ties the two: a
 * run handed another wallet's key would resume from this store's height and
 * write that wallet's notes into it, and only a rescan would clear them. So
 * the first run on a store records a fingerprint of its key (a hash of the
 * Orchard full viewing key, never the key), and a later run with another key
 * is refused. A rescan clears the store, fingerprint included.
 */

/** the meta row that holds it */
export const STORE_KEY_META = 'keyFingerprint';

/** what a refused run says */
export const STORE_KEY_MISMATCH =
  "this wallet's store was filled by another key: rescan the wallet to start it again";

/** a fingerprint of an Orchard full viewing key (hex), for telling keys apart only */
export const storeKeyFingerprint = async (fvkHex: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`zafu store key\0${fvkHex.toLowerCase()}`),
  );
  return Array.from(new Uint8Array(digest).subarray(0, 16), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
};

/** may a run with this key go on in the store? A store no key has claimed yet takes it */
export const storeKeyFits = (stored: string | undefined, fingerprint: string): boolean =>
  stored === undefined || stored === fingerprint;
