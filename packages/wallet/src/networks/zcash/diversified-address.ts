/**
 * diversified-address - per-contact zcash receiving addresses
 *
 * each contact gets a unique diversified address derived from the same FVK.
 * all diversified addresses decrypt to the same wallet during scanning.
 * the diversifier index identifies which contact (or referral chain) a
 * payment came through.
 *
 * index allocation:
 *   receive   = a fresh random 88-bit index each time an address is shown or
 *               copied (extension state/shielded-receive-index.ts), so no
 *               index, 0 included, is a stable "public" address
 *   1000+     = per-contact diversified addresses, below
 *
 * NOTE: address_from_ufvk takes a u32, so the 48-bit index derived below is
 * cut to its low 32 bits on the way into wasm. Contact addresses therefore
 * spread over 2^32, not 2^48 (birthday ~65k contacts, not ~16M). Moving them
 * to address_from_ufvk_at_index would change every address already handed to
 * a contact, so it waits for a decision rather than riding along.
 *
 * index derivation:
 *   index = 1000 + (SHA-256(contact_id)[0:6] as u48)
 *
 * using 48 bits of SHA-256 gives collision probability ~50% at ~16 million
 * contacts (birthday bound). on collision, two contacts share an address
 * and referral attribution is ambiguous for those two contacts only.
 *
 * orchard's diversifier space is 88 bits. we use 48 because JS Number
 * is safe up to 2^53. the WASM API takes a JS number parameter.
 *
 * collision is non-catastrophic: payments still arrive, you just can't
 * distinguish which of the two colliding contacts the payment came through.
 */

const CONTACT_INDEX_BASE = 1000;

/**
 * derive a stable diversifier index for a contact.
 * the same contact_id always produces the same index.
 * uses 48 bits of SHA-256 for ~16M contact birthday bound.
 */
export async function contactDiversifierIndex(contactId: string): Promise<number> {
  const data = new TextEncoder().encode(contactId);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  // read 6 bytes (48 bits) as a number - safe in JS Number (< 2^53)
  let index = 0;
  for (let i = 0; i < 6; i++) {
    index = index * 256 + bytes[i]!;
  }
  return CONTACT_INDEX_BASE + index;
}

/** record of a diversified address shared with a contact */
export interface DiversifiedAddressRecord {
  /** diversifier index used */
  diversifierIndex: number;
  /** who this address was shared with (contact id or name) */
  sharedWith: string;
  /** the derived address string (for quick lookup during scan) */
  address: string;
  /** when shared */
  sharedAt: number;
}

/**
 * look up who a diversified address was shared with.
 * during sync, match the receiving diversifier to a contact.
 */
export function traceAddressReferral(
  records: DiversifiedAddressRecord[],
  diversifierIndex: number,
): DiversifiedAddressRecord | undefined {
  return records.find(r => r.diversifierIndex === diversifierIndex);
}
