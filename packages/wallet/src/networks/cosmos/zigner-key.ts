/**
 * A Zigner cosmos key code, read as the address it owns on one chain (#146).
 *
 * Zigner exports `{"type":"cosmos-accounts","public_key":"<33-byte hex>",
 * "addresses":[{chain_id,address,prefix}]}`, or just the key as hex. The
 * address is derived from the key (ripemd160(sha256(pubkey)), coin type 118),
 * never taken on trust from the listed addresses: a listed address for the
 * same prefix that disagrees with the key refuses the whole code.
 */

import { encodeSecp256k1Pubkey, pubkeyToAddress } from '@cosmjs/amino';
import { fromHex } from '@cosmjs/encoding';

export type ZignerKeyAddress =
  | { address: string; refused?: undefined }
  | { address: ''; refused: string };

const KEY_HEX = /^(?:0x)?(0[23][0-9a-f]{64})$/i;

export const ZIGNER_KEY_MISMATCH =
  'this code lists an address its own key does not own · nothing was filled';

type Listed = { prefix?: unknown; address?: unknown }[] | undefined;

const read = (text: string): { key?: string; listed?: Listed } => {
  const bare = KEY_HEX.exec(text);
  if (bare) {
    return { key: bare[1] };
  }
  try {
    const json = JSON.parse(text) as { type?: unknown; public_key?: unknown; addresses?: unknown };
    if (json.type !== 'cosmos-accounts' || typeof json.public_key !== 'string') {
      return {};
    }
    const listed = Array.isArray(json.addresses) ? (json.addresses as Listed) : undefined;
    return { key: KEY_HEX.exec(json.public_key)?.[1], listed };
  } catch {
    return {};
  }
};

/** undefined when the text is not a zigner cosmos key at all */
export const zignerKeyAddress = (text: string, prefix: string): ZignerKeyAddress | undefined => {
  const { key, listed } = read(text.trim());
  if (!key) {
    return undefined;
  }
  const address = pubkeyToAddress(encodeSecp256k1Pubkey(fromHex(key)), prefix);
  const claimed = listed?.find(a => a.prefix === prefix);
  if (claimed && claimed.address !== address) {
    return { address: '', refused: ZIGNER_KEY_MISMATCH };
  }
  return { address };
};
