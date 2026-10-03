/**
 * What a pasted or stored string is, on which chain. One classifier for the
 * contacts book, the swap fields and "yours": a zid is someone's identity and
 * never an address, garbage is never stored, and only zcash and penumbra are
 * payable from zafu itself.
 *
 * The chain a field is for (`chain`) settles what the string alone cannot:
 * a 0x address is the same on ethereum, base or arbitrum, and 64 hex is a near
 * implicit account only in a near field; everywhere else it is a zid.
 */
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import type { ContactAddress, ContactNetwork } from '../state/contacts';

export type AddressChain = ContactNetwork;

export type AddressKind =
  | { kind: 'zcash'; pool: 'shielded' | 'transparent' | 'tex' }
  | { kind: 'penumbra' }
  | { kind: 'bitcoin' }
  | { kind: 'evm' }
  | { kind: 'solana' }
  | { kind: 'near' }
  | { kind: 'cosmos'; prefix: string }
  | { kind: 'zid' }
  | { kind: 'unknown' };

/** chains that share the 0x address format; the field says which one */
export const EVM_CHAINS: readonly AddressChain[] = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'avalanche',
  'bsc',
];

/** cosmos bech32 prefixes zafu knows, and the chain each one names */
const COSMOS_PREFIXES: Record<string, string> = {
  cosmos: 'cosmos hub',
  osmo: 'osmosis',
  noble: 'noble',
  inj: 'injective',
  celestia: 'celestia',
  neutron: 'neutron',
  stride: 'stride',
  axelar: 'axelar',
  juno: 'juno',
  akash: 'akash',
  dydx: 'dydx',
  kujira: 'kujira',
  stars: 'stargaze',
  secret: 'secret',
  terra: 'terra',
};

/** a swap route's chain code (state/swap/tokens.ts) to the chain an address field is for */
const SWAP_CHAIN: Record<string, AddressChain> = {
  zec: 'zcash',
  btc: 'bitcoin',
  eth: 'ethereum',
  base: 'base',
  arb: 'arbitrum',
  op: 'optimism',
  pol: 'polygon',
  avax: 'avalanche',
  bsc: 'bsc',
  sol: 'solana',
  near: 'near',
  gaia: 'cosmos',
};

/** the address chain for a swap chain code; undefined for chains zafu cannot check yet */
export const chainOfSwap = (code: string | undefined): AddressChain | undefined =>
  code ? SWAP_CHAIN[code.toLowerCase()] : undefined;

// --- bech32 / bech32m (BIP-173, BIP-350) ---

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const polymod = (values: number[]) => {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) {
        chk ^= GEN[i]!;
      }
    }
  }
  return chk >>> 0;
};

const bech32 = (
  s: string,
): { hrp: string; words: number[]; spec: 'bech32' | 'bech32m' } | undefined => {
  if (s.length > 90 || (s !== s.toLowerCase() && s !== s.toUpperCase())) {
    return undefined;
  }
  const lower = s.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) {
    return undefined;
  }
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) {
      return undefined;
    }
    data.push(v);
  }
  const expanded = [
    ...[...hrp].map(c => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map(c => c.charCodeAt(0) & 31),
  ];
  const check = polymod([...expanded, ...data]);
  const spec = check === 1 ? 'bech32' : check === 0x2bc830a3 ? 'bech32m' : undefined;
  return spec && { hrp, words: data.slice(0, -6), spec };
};

/** 5-bit words to bytes; undefined when the padding is not zero */
const fromWords = (words: number[]): number[] | undefined => {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return bits >= 5 || (acc << (8 - bits)) & 0xff ? undefined : out;
};

const isSegwit = (s: string): boolean => {
  const d = bech32(s);
  if (d?.hrp !== 'bc' || !d.words.length) {
    return false;
  }
  const [version, ...rest] = d.words as [number, ...number[]];
  const program = fromWords(rest);
  if (version > 16 || !program || program.length < 2 || program.length > 40) {
    return false;
  }
  return version === 0
    ? d.spec === 'bech32' && (program.length === 20 || program.length === 32)
    : d.spec === 'bech32m';
};

/** bech32 prefixes of other chains, never read as cosmos */
const NOT_COSMOS = new Set(['bc', 'tb', 'bcrt', 'ltc', 'tltc', 'tex', 'zs', 'u', 'utest']);

/**
 * A cosmos-sdk account: classic bech32 over 20 or 32 bytes. The ibc chains
 * come from the registry at runtime, so any plain lowercase prefix counts,
 * not only the ones named above.
 */
const cosmosPrefix = (s: string): string | undefined => {
  const d = bech32(s);
  const bytes = d?.spec === 'bech32' ? fromWords(d.words) : undefined;
  return d &&
    bytes &&
    (bytes.length === 20 || bytes.length === 32) &&
    /^[a-z]+$/.test(d.hrp) &&
    !NOT_COSMOS.has(d.hrp) &&
    !d.hrp.startsWith('penumbra')
    ? d.hrp
    : undefined;
};

// --- base58 ---

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const base58 = (s: string): Uint8Array | undefined => {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) {
      return undefined;
    }
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) {
    bytes.unshift(Number(n & 0xffn));
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) {
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
};

const isBase58Bitcoin = (s: string): boolean => {
  if (!/^[13]/.test(s) || s.length < 26 || s.length > 35) {
    return false;
  }
  const b = base58(s);
  if (b?.length !== 25 || (b[0] !== 0x00 && b[0] !== 0x05)) {
    return false;
  }
  const sum = sha256(sha256(b.subarray(0, 21)));
  return sum.subarray(0, 4).every((v, i) => v === b[21 + i]);
};

const isSolana = (s: string): boolean =>
  s.length >= 32 && s.length <= 44 && base58(s)?.length === 32;

// --- evm, near ---

/** 0x and 40 hex; a mixed-case address must carry a correct EIP-55 checksum */
const isEvm = (s: string): boolean => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    return false;
  }
  const hex = s.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) {
    return true;
  }
  const hash = keccak_256(new TextEncoder().encode(hex.toLowerCase()));
  return [...hex].every((c, i) => {
    const nibble = (hash[i >> 1]! >> (i % 2 ? 0 : 4)) & 0xf;
    return /[0-9]/.test(c) || (nibble >= 8 ? c === c.toUpperCase() : c === c.toLowerCase());
  });
};

const NEAR_NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)+near$/;
const HEX64 = /^[0-9a-f]{64}$/i;

// --- zcash, penumbra: shapes as before ---

const BECH32 = '[02-9ac-hj-np-z]';
const ZCASH_SHIELDED = new RegExp(`^(u1${BECH32}{60,}|zs1${BECH32}{70,})$`);
const ZCASH_TRANSPARENT = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;
const ZCASH_TEX = new RegExp(`^tex1${BECH32}{30,}$`);
const PENUMBRA = new RegExp(`^penumbra(compat)?1${BECH32}{50,}$`);

/**
 * What `raw` is. With a `chain`, an address on another chain is still named
 * for what it is; the field's chain only decides the cases the string cannot
 * (64 hex: near implicit in a near field, a zid anywhere else).
 */
export const addressKind = (raw: string, chain?: AddressChain): AddressKind => {
  const s = raw.trim();
  if (ZCASH_SHIELDED.test(s)) {
    return { kind: 'zcash', pool: 'shielded' };
  }
  if (ZCASH_TRANSPARENT.test(s)) {
    return { kind: 'zcash', pool: 'transparent' };
  }
  if (ZCASH_TEX.test(s)) {
    return { kind: 'zcash', pool: 'tex' };
  }
  if (PENUMBRA.test(s)) {
    return { kind: 'penumbra' };
  }
  if (HEX64.test(s)) {
    return chain === 'near' ? { kind: 'near' } : { kind: 'zid' };
  }
  if (isEvm(s)) {
    return { kind: 'evm' };
  }
  if (NEAR_NAMED.test(s)) {
    return { kind: 'near' };
  }
  if (isSegwit(s) || isBase58Bitcoin(s)) {
    return { kind: 'bitcoin' };
  }
  const prefix = cosmosPrefix(s);
  if (prefix) {
    return { kind: 'cosmos', prefix };
  }
  if (isSolana(s)) {
    return { kind: 'solana' };
  }
  return { kind: 'unknown' };
};

/** does this kind of address belong on that chain */
const fits = (k: AddressKind, chain: AddressChain): boolean =>
  k.kind === 'evm' ? EVM_CHAINS.includes(chain) : k.kind === chain;

/** is `raw` an address on `chain` */
export const isAddressOn = (raw: string, chain: AddressChain): boolean =>
  fits(addressKind(raw, chain), chain);

/**
 * The chain an address string is on when nothing else says (an evm address
 * reads as ethereum); undefined for a zid or anything that is no address.
 */
export const inferChain = (raw: string): AddressChain | undefined => {
  const k = addressKind(raw);
  return k.kind === 'evm'
    ? 'ethereum'
    : k.kind === 'zid' || k.kind === 'unknown'
      ? undefined
      : k.kind;
};

/** why a string cannot join an address list, said calmly; undefined when it can */
export const refusalOf = (raw: string, chain?: AddressChain): string | undefined => {
  const k = addressKind(raw, chain);
  if (k.kind === 'zid') {
    return "that is someone's zafu identity, not an address · please ask for their card";
  }
  if (k.kind === 'unknown') {
    return chain
      ? `that does not look like a ${chainLabel(chain)} address · please check it`
      : 'zafu does not know this address · please check it';
  }
  if (chain && !fits(k, chain)) {
    return `that looks like another chain's address · please paste a ${chainLabel(chain)} one`;
  }
  return undefined;
};

/**
 * The chain a saved contact address is really on, or undefined when it is no
 * address at all (a zid, a card link, garbage).
 *
 * Migration: before 5acc72df, anything that did not start with "penumbra" was
 * saved with network "zcash", so a bitcoin or ethereum address from then sits
 * under zcash. The stored network counts when the address fits it; otherwise
 * the address names its own chain. Nothing is rewritten in storage, so those
 * contacts keep every address and now show and file them by their real chain,
 * and such an address is never offered to the zcash send.
 */
export const effectiveNetwork = (a: Pick<ContactAddress, 'address' | 'network'>) =>
  isAddressOn(a.address, a.network) ? a.network : inferChain(a.address);

/** a stored entry that really is an address */
export const isRealAddress = (a: Pick<ContactAddress, 'address' | 'network'>): boolean =>
  effectiveNetwork(a) !== undefined;

/** only these are paid from zafu directly */
export const isPayable = (network: AddressChain | undefined): network is 'zcash' | 'penumbra' =>
  network === 'zcash' || network === 'penumbra';

/** the chain's name as a person says it */
export const chainLabel = (chain: AddressChain): string => (chain === 'bsc' ? 'bnb chain' : chain);

/** "zcash · shielded", "penumbra", "bitcoin", "base", "osmosis"; undefined when no address */
export const addressLabel = (
  a: Pick<ContactAddress, 'address' | 'network'>,
): string | undefined => {
  const network = effectiveNetwork(a);
  if (!network) {
    return undefined;
  }
  const k = addressKind(a.address, network);
  return k.kind === 'zcash'
    ? `zcash · ${k.pool}`
    : k.kind === 'cosmos'
      ? (COSMOS_PREFIXES[k.prefix] ?? `cosmos · ${k.prefix}`)
      : chainLabel(network);
};
