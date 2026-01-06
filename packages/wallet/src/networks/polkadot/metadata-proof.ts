/**
 * merkleized metadata proof generation for polkadot
 *
 * generates compact proofs for transactions that zigner can verify.
 * removes the need for full metadata storage in the cold wallet.
 *
 * see: https://polkadot-fellows.github.io/RFCs/approved/0078-merkleized-metadata.html
 */

import { merkleizeMetadata } from '@polkadot-api/merkleize-metadata';
import type { SupportedChain } from './light-client';
import { CHAIN_INFO } from './light-client';

/** cached merkleized metadata per chain */
const metadataCache: Map<string, ReturnType<typeof merkleizeMetadata>> = new Map();

/** cache key includes spec version to invalidate on runtime upgrade */
function cacheKey(chain: SupportedChain, specVersion: number): string {
  return `${chain}:${specVersion}`;
}

/**
 * get or create merkleized metadata for a chain
 * caches result per chain+specVersion
 */
export async function getMerkleizedMetadata(
  chain: SupportedChain,
  rawMetadata: Uint8Array,
  specVersion: number,
  specName: string
): Promise<ReturnType<typeof merkleizeMetadata>> {
  const key = cacheKey(chain, specVersion);
  const cached = metadataCache.get(key);
  if (cached) return cached;

  const info = CHAIN_INFO[chain];

  const merkleized = merkleizeMetadata(rawMetadata, {
    decimals: info.decimals,
    tokenSymbol: info.symbol,
    specVersion,
    specName,
    base58Prefix: info.ss58Prefix,
  });

  metadataCache.set(key, merkleized);

  // cleanup old versions for this chain
  for (const [k] of metadataCache) {
    if (k.startsWith(`${chain}:`) && k !== key) {
      metadataCache.delete(k);
    }
  }

  return merkleized;
}

/**
 * generate metadata proof for an extrinsic
 *
 * returns encoded proof that zigner can use to decode and verify the transaction
 */
export async function generateExtrinsicProof(
  chain: SupportedChain,
  rawMetadata: Uint8Array,
  specVersion: number,
  specName: string,
  callData: Uint8Array,
  signedExtensions: Uint8Array,
  additionalSigned: Uint8Array
): Promise<Uint8Array> {
  const merkleized = await getMerkleizedMetadata(
    chain,
    rawMetadata,
    specVersion,
    specName
  );

  return merkleized.getProofForExtrinsicParts(
    callData,
    signedExtensions,
    additionalSigned
  );
}

/**
 * generate metadata digest (hash) for a chain
 *
 * this is what gets signed as part of CheckMetadataHash
 */
export async function generateMetadataDigest(
  chain: SupportedChain,
  rawMetadata: Uint8Array,
  specVersion: number,
  specName: string
): Promise<Uint8Array> {
  const merkleized = await getMerkleizedMetadata(
    chain,
    rawMetadata,
    specVersion,
    specName
  );

  return merkleized.digest();
}

/** clear metadata cache (for testing or memory pressure) */
export function clearMetadataCache(): void {
  metadataCache.clear();
}

/**
 * UOS payload codes for Polkadot Vault / Zigner
 * see: https://github.com/nickkuk/polkadot-vault-parity/blob/master/docs/src/development/UOS.md
 */
export const UOS_PAYLOAD_CODE = {
  /** legacy transaction (requires full metadata on device) */
  TRANSACTION: 0x00,
  /** transaction with merkleized metadata proof */
  TRANSACTION_WITH_PROOF: 0x06,
  /** raw message signing */
  MESSAGE: 0x03,
  /** dynamic derivation transaction with proof (key derived on-the-fly) */
  DD_TRANSACTION_WITH_PROOF: 0x07,
} as const;

/**
 * UOS crypto codes
 */
export const UOS_CRYPTO_CODE = {
  ED25519: 0x00,
  SR25519: 0x01,
  ECDSA: 0x02,
} as const;

/**
 * build UOS payload for zigner with metadata proof
 *
 * format: [proof][call][extensions]
 */
export function buildUosPayloadWithProof(
  proof: Uint8Array,
  callData: Uint8Array,
  signedExtensions: Uint8Array
): Uint8Array {
  const payload = new Uint8Array(
    proof.length + callData.length + signedExtensions.length
  );

  let offset = 0;
  payload.set(proof, offset);
  offset += proof.length;
  payload.set(callData, offset);
  offset += callData.length;
  payload.set(signedExtensions, offset);

  return payload;
}
