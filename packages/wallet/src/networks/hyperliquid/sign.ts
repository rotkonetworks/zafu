/**
 * Hyperliquid user-signed actions (usdSend, spotSend, withdraw3): EIP-712
 * typed data, signed by the account's own key. An agent (API) wallet may not
 * sign these.
 *
 * The digest is built by hand: the struct names carry a colon
 * (`HyperliquidTransaction:UsdSend`), which viem's typed-data encoder refuses.
 * Field lists and the domain follow the official python sdk
 * (hyperliquid/utils/signing.py); sign.test.ts holds its signature vectors.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, hexToBytes } from '@noble/hashes/utils';
import { secp256k1 } from '@noble/curves/secp256k1';

export type HyperliquidChain = 'Mainnet' | 'Testnet';

interface Transfer {
  hyperliquidChain: HyperliquidChain;
  /** the chain id the EIP-712 domain names; any chain, it only binds the signature */
  signatureChainId: `0x${string}`;
  destination: string;
  /** decimal string, as it is shown on review */
  amount: string;
  /** milliseconds; also the action's nonce */
  time: number;
}

export type UserAction =
  | (Transfer & { type: 'usdSend' })
  | (Transfer & { type: 'withdraw3' })
  | (Transfer & { type: 'spotSend'; token: string });

type FieldType = 'string' | 'uint64';

/** each action's EIP-712 struct: its name and fields, in signing order */
const STRUCTS: Record<UserAction['type'], { name: string; fields: [string, FieldType][] }> = {
  usdSend: {
    name: 'HyperliquidTransaction:UsdSend',
    fields: [
      ['hyperliquidChain', 'string'],
      ['destination', 'string'],
      ['amount', 'string'],
      ['time', 'uint64'],
    ],
  },
  spotSend: {
    name: 'HyperliquidTransaction:SpotSend',
    fields: [
      ['hyperliquidChain', 'string'],
      ['destination', 'string'],
      ['token', 'string'],
      ['amount', 'string'],
      ['time', 'uint64'],
    ],
  },
  withdraw3: {
    name: 'HyperliquidTransaction:Withdraw',
    fields: [
      ['hyperliquidChain', 'string'],
      ['destination', 'string'],
      ['amount', 'string'],
      ['time', 'uint64'],
    ],
  },
};

const utf8 = (s: string) => new TextEncoder().encode(s);

const word = (n: bigint): Uint8Array => hexToBytes(n.toString(16).padStart(64, '0'));

const ENCODE: Record<FieldType, (v: unknown) => Uint8Array> = {
  string: v => keccak_256(utf8(v as string)),
  uint64: v => word(BigInt(v as number)),
};

const DOMAIN_TYPE = keccak_256(
  utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

/** the 32 bytes the key signs: keccak(0x1901 || domain separator || struct hash) */
export function userActionDigest(action: UserAction): Uint8Array {
  const { name, fields } = STRUCTS[action.type];
  const domain = keccak_256(
    concatBytes(
      DOMAIN_TYPE,
      keccak_256(utf8('HyperliquidSignTransaction')),
      keccak_256(utf8('1')),
      word(BigInt(action.signatureChainId)),
      word(0n), // verifyingContract: the zero address
    ),
  );
  const values = action as unknown as Record<string, unknown>;
  const struct = keccak_256(
    concatBytes(
      keccak_256(utf8(`${name}(${fields.map(([f, t]) => `${t} ${f}`).join(',')})`)),
      ...fields.map(([f, t]) => ENCODE[t](values[f])),
    ),
  );
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), domain, struct));
}

export interface HyperliquidSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: 27 | 28;
}

const hex32 = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;

/** sign with the account's own key; the caller zeroes `privateKey` after use */
export function signUserAction(privateKey: Uint8Array, action: UserAction): HyperliquidSignature {
  const sig = secp256k1.sign(userActionDigest(action), privateKey, { lowS: true });
  return { r: hex32(sig.r), s: hex32(sig.s), v: sig.recovery === 0 ? 27 : 28 };
}
