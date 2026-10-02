/**
 * Which person a payment came from, by which of your addresses it was paid
 * to. Each card you send hands one person an address of their own (a
 * diversifier index), recorded in `diversifiedAddresses`; a note that arrives
 * on that address is theirs, whatever its memo claims. This is the wallet's
 * own record, so it outranks a `reply:` line, which the sender writes.
 *
 * Addresses compare by their orchard receiver bytes, never as text, so the
 * same receiver inside two different encodings still matches. A record from
 * another wallet can never match: its receivers come from another key.
 */

import {
  encodeOrchardUnifiedAddress,
  orchardReceiverOf,
} from '@repo/wallet/networks/zcash/unified-address';
import type { DiversifiedAddressRecord } from '@repo/wallet/networks/zcash/diversified-address';
import type { Contact } from './contacts';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

const fromHex = (h: string): Uint8Array | undefined =>
  /^[0-9a-f]{86}$/i.test(h) ? Uint8Array.from(h.match(/../g)!, b => parseInt(b, 16)) : undefined;

/**
 * The orchard receiver of an address zafu recorded: a unified address, or the
 * wasm's `u1orchard:<hex>` form that older records hold.
 */
const receiverOf = (address: string): Uint8Array | undefined => {
  const debug = /^u(?:test)?1orchard:([0-9a-f]{86})$/i.exec(address.trim());
  return debug ? fromHex(debug[1]!) : orchardReceiverOf(address);
};

/** a note's raw receiver (43 bytes, hex) as the address string it was paid to */
export const receivingAddress = (receiverHex: string | undefined): string | undefined => {
  const raw = receiverHex && fromHex(receiverHex);
  return raw ? encodeOrchardUnifiedAddress(raw, true) : undefined;
};

export interface ReceivingMatch {
  /** the diversifier index of your address it arrived on */
  diversifierIndex: number;
  /** the person you gave that address to, when they are saved */
  contact?: Contact;
  /** where to answer them: their own zcash address, when saved */
  personAddress?: string;
}

/**
 * Resolve a note's receiver to the address record it belongs to, and that
 * record to a saved contact (by id; older records were keyed by name).
 */
export const matchReceiver = (
  receiverHex: string | undefined,
  records: readonly DiversifiedAddressRecord[],
  contacts: readonly Contact[],
): ReceivingMatch | undefined => {
  const raw = receiverHex && fromHex(receiverHex);
  if (!raw) {
    return undefined;
  }
  const want = hex(raw).toLowerCase();
  const record = records.find(r => {
    const theirs = receiverOf(r.address);
    return theirs !== undefined && hex(theirs) === want;
  });
  if (!record) {
    return undefined;
  }
  const contact =
    contacts.find(c => c.id === record.sharedWith) ??
    contacts.find(c => c.name === record.sharedWith);
  return {
    diversifierIndex: record.diversifierIndex,
    contact,
    personAddress: (Array.isArray(contact?.addresses) ? contact.addresses : []).find(
      a => a.network === 'zcash',
    )?.address,
  };
};
