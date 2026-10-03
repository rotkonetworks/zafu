/**
 * What a pasted or stored string is. A contact's address list holds only
 * addresses zafu can pay: a zid is someone's identity and arrives with their
 * card, and a card or zafu link goes to the link reader, never into the list.
 */
import type { ContactAddress } from '../../../state/contacts';

export type AddressKind =
  | { kind: 'zcash'; pool: 'shielded' | 'transparent' }
  | { kind: 'penumbra' }
  | { kind: 'zid' }
  | { kind: 'unknown' };

const BECH32 = '[02-9ac-hj-np-z]';
const ZCASH_SHIELDED = new RegExp(`^(u1${BECH32}{60,}|zs1${BECH32}{70,})$`);
const ZCASH_TRANSPARENT = new RegExp(`^(t[13][1-9A-HJ-NP-Za-km-z]{33}|tex1${BECH32}{30,})$`);
const PENUMBRA = new RegExp(`^penumbra(compat)?1${BECH32}{50,}$`);

export const addressKind = (raw: string): AddressKind => {
  const s = raw.trim();
  if (ZCASH_SHIELDED.test(s)) {
    return { kind: 'zcash', pool: 'shielded' };
  }
  if (ZCASH_TRANSPARENT.test(s)) {
    return { kind: 'zcash', pool: 'transparent' };
  }
  if (PENUMBRA.test(s)) {
    return { kind: 'penumbra' };
  }
  if (/^[0-9a-f]{64}$/i.test(s)) {
    return { kind: 'zid' };
  }
  return { kind: 'unknown' };
};

/** why a string cannot join an address list, said calmly; undefined when it can */
export const refusalOf = (raw: string): string | undefined => {
  const k = addressKind(raw).kind;
  return k === 'zid'
    ? "that is someone's zafu identity, not an address · please ask for their card"
    : k === 'unknown'
      ? 'zafu cannot pay this · please paste a zcash or penumbra address'
      : undefined;
};

/** a stored entry that really is the address its network claims */
export const isRealAddress = (a: ContactAddress): boolean => {
  const k = addressKind(a.address).kind;
  return (k === 'zcash' || k === 'penumbra') && k === a.network;
};

/** "zcash · shielded", "zcash · transparent", "penumbra" */
export const addressLabel = (address: string): string => {
  const k = addressKind(address);
  return k.kind === 'zcash' ? `zcash · ${k.pool}` : k.kind;
};
