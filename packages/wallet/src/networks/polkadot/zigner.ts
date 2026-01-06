/**
 * polkadot zigner signing integration with merkleized metadata
 *
 * builds transactions with metadata proofs for zigner to sign via qr code.
 * uses polkadot-api for transaction construction and merkleized-metadata for proofs.
 *
 * the proof allows zigner to decode and verify the transaction without storing
 * full runtime metadata - making updates unnecessary and QR codes smaller.
 */

import type { PolkadotNetworkKeys } from '../common/types';
import { CHAIN_IDS, QR_TYPES } from '../common/types';
import { getLightClient, CHAIN_INFO, type SupportedChain } from './light-client';
import {
  generateExtrinsicProof,
  UOS_PAYLOAD_CODE,
  UOS_CRYPTO_CODE,
  buildUosPayloadWithProof,
} from './metadata-proof';

/** transaction types we can build */
export type PolkadotTxType = 'transfer' | 'stake' | 'unstake' | 'nominate';

/** unsigned transaction ready for zigner with merkleized proof */
export interface UnsignedPolkadotTx {
  /** call data (pallet + call + args) */
  callData: Uint8Array;
  /** signed extensions (nonce, tip, era, etc.) */
  signedExtensions: Uint8Array;
  /** additional signed data (genesis hash, block hash, spec version, etc.) */
  additionalSigned: Uint8Array;
  /** merkleized metadata proof */
  proof: Uint8Array;
  /** complete UOS payload for QR */
  uosPayload: Uint8Array;
  /** chain genesis hash */
  genesisHash: string;
  /** transaction nonce */
  nonce: number;
  /** spec version */
  specVersion: number;
  /** human readable summary */
  summary: string;
}

/** signed transaction from zigner */
export interface SignedPolkadotTx {
  /** signature (64 bytes for sr25519/ed25519) */
  signature: Uint8Array;
  /** signer public key */
  signer: Uint8Array;
}

/**
 * build qr code data for zigner signing with merkleized metadata proof
 *
 * UOS format: [0x53][crypto_type][payload_type][pubkey][payload]
 * - 0x53 = substrate prefix
 * - crypto_type: 0x00=ed25519, 0x01=sr25519
 * - payload_type: 0x06=transaction_with_proof (backwards compatible with polkadot vault)
 * - pubkey: 32 bytes
 * - payload: [proof][call][extensions]
 */
export function buildSignRequestQr(
  keys: PolkadotNetworkKeys,
  tx: UnsignedPolkadotTx
): string {
  const cryptoType = keys.scheme === 'sr25519'
    ? UOS_CRYPTO_CODE.SR25519
    : UOS_CRYPTO_CODE.ED25519;

  // public key (32 bytes)
  const pubkey = hexToBytes(keys.publicKey);

  // build UOS payload: header + pubkey + tx payload
  const header = new Uint8Array([
    0x53, // substrate
    cryptoType,
    UOS_PAYLOAD_CODE.TRANSACTION_WITH_PROOF,
  ]);

  const payload = new Uint8Array(header.length + pubkey.length + tx.uosPayload.length);
  let offset = 0;
  payload.set(header, offset);
  offset += header.length;
  payload.set(pubkey, offset);
  offset += pubkey.length;
  payload.set(tx.uosPayload, offset);

  return Buffer.from(payload).toString('hex');
}

/** convert hex string to bytes */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * parse signature qr from zigner
 * format: [0x53][chain_id][SIGNATURES][signature]
 */
export function parseSignatureQr(qrHex: string): SignedPolkadotTx {
  const bytes = Buffer.from(qrHex, 'hex');

  if (bytes[0] !== 0x53) {
    throw new Error('invalid qr prefix');
  }

  const chainId = bytes[1];
  if (chainId !== CHAIN_IDS.SUBSTRATE_SR25519 && chainId !== CHAIN_IDS.SUBSTRATE_ED25519) {
    throw new Error('not a substrate signature');
  }

  if (bytes[2] !== QR_TYPES.SIGNATURES) {
    throw new Error('not a signature response');
  }

  // signature is 64 bytes, followed by 32 byte public key
  const signature = bytes.slice(3, 67);
  const signer = bytes.slice(67, 99);

  return {
    signature: new Uint8Array(signature),
    signer: new Uint8Array(signer),
  };
}

/**
 * build transfer transaction for zigner signing with merkleized metadata proof
 *
 * generates a complete transaction with proof that zigner can decode and verify
 * without needing the full runtime metadata stored locally.
 */
export async function buildTransferTx(
  chain: SupportedChain,
  from: PolkadotNetworkKeys,
  to: string,
  amount: bigint
): Promise<UnsignedPolkadotTx> {
  const client = getLightClient(chain);

  if (client.state.state !== 'ready') {
    await client.connect();
  }

  // get all the pieces we need
  const [nonce, rawMetadata, runtimeVersion, genesisHash] = await Promise.all([
    client.getNonce(from),
    client.getRawMetadata(),
    client.getRuntimeVersion(),
    client.getGenesisHash(),
  ]);

  // build the transaction parts
  // TODO: use polkadot-api to properly encode call and extensions
  const callData = await client.buildTransfer(from, to, amount);

  // for now, use placeholder extensions
  // in production, these need to be properly encoded signed extensions
  const signedExtensions = new Uint8Array([
    // CheckNonZeroSender (empty)
    // CheckSpecVersion (empty in extrinsic, spec_version in additional)
    // CheckTxVersion (empty in extrinsic, tx_version in additional)
    // CheckGenesis (empty in extrinsic, genesis_hash in additional)
    // CheckMortality (era + block_hash in additional)
    0x00, // immortal era
    // CheckNonce
    ...encodeCompact(nonce),
    // ChargeTransactionPayment (tip)
    0x00, // no tip
    // CheckMetadataHash (mode + optional hash)
    0x01, // mode = enabled
  ]);

  // additional signed data (included in signature but not transaction)
  // genesis hash, block hash, spec version, tx version, metadata hash
  const additionalSigned = new Uint8Array([
    ...hexToBytes(genesisHash), // genesis hash (32 bytes)
    ...hexToBytes(genesisHash), // block hash for immortal (32 bytes)
    ...encodeU32LE(runtimeVersion.specVersion), // spec version
    ...encodeU32LE(0), // tx version (TODO: get from runtime)
    // metadata hash will be filled by merkleized-metadata
  ]);

  // generate merkleized metadata proof
  const proof = await generateExtrinsicProof(
    chain,
    rawMetadata,
    runtimeVersion.specVersion,
    runtimeVersion.specName,
    callData,
    signedExtensions,
    additionalSigned
  );

  // build complete UOS payload
  const uosPayload = buildUosPayloadWithProof(proof, callData, signedExtensions);

  // format amount for display
  const info = CHAIN_INFO[chain];
  const displayAmount = (Number(amount) / Math.pow(10, info.decimals)).toFixed(4);

  return {
    callData,
    signedExtensions,
    additionalSigned,
    proof,
    uosPayload,
    genesisHash,
    nonce,
    specVersion: runtimeVersion.specVersion,
    summary: `transfer ${displayAmount} ${info.symbol} to ${to.slice(0, 8)}...`,
  };
}

/** encode compact (SCALE variable-length) integer */
function encodeCompact(value: number): Uint8Array {
  if (value < 0x40) {
    return new Uint8Array([value << 2]);
  } else if (value < 0x4000) {
    return new Uint8Array([(value << 2) | 0x01, value >> 6]);
  } else if (value < 0x40000000) {
    return new Uint8Array([
      (value << 2) | 0x02,
      value >> 6,
      value >> 14,
      value >> 22,
    ]);
  } else {
    throw new Error('compact encoding for large values not implemented');
  }
}

/** encode u32 as little-endian bytes */
function encodeU32LE(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ]);
}

/**
 * broadcast signed transaction
 *
 * combines the call data, extensions, and signature into a signed extrinsic
 * and submits it via the light client.
 */
export async function broadcastTx(
  chain: SupportedChain,
  unsigned: UnsignedPolkadotTx,
  signed: SignedPolkadotTx
): Promise<string> {
  const client = getLightClient(chain);

  if (client.state.state !== 'ready') {
    throw new Error('light client not ready');
  }

  // build signed extrinsic
  // format: [length][version|signed][address][signature][era][nonce][tip][metadata_mode][call]
  // version 0x84 = 0x80 (signed) | 0x04 (extrinsic v4)

  // simplified encoding - in production use polkadot-api's proper encoding
  const version = 0x84; // signed extrinsic v4

  // MultiAddress::Id variant (0x00) + 32 byte account id
  const multiAddress = new Uint8Array([0x00, ...signed.signer]);

  // MultiSignature variant depends on key type
  // 0x00 = Ed25519, 0x01 = Sr25519, 0x02 = Ecdsa
  const signatureType = unsigned.uosPayload[2] === UOS_CRYPTO_CODE.ED25519 ? 0x00 : 0x01;
  const multiSignature = new Uint8Array([signatureType, ...signed.signature]);

  // build full extrinsic body (without length prefix)
  const body = new Uint8Array([
    version,
    ...multiAddress,
    ...multiSignature,
    ...unsigned.signedExtensions,
    ...unsigned.callData,
  ]);

  // add compact length prefix
  const lengthPrefix = encodeCompact(body.length);
  const signedTx = new Uint8Array(lengthPrefix.length + body.length);
  signedTx.set(lengthPrefix, 0);
  signedTx.set(body, lengthPrefix.length);

  return client.broadcast(signedTx);
}

/** ss58 address validation */
export function isValidSs58(address: string): boolean {
  // basic validation - starts with valid prefix and correct length
  if (address.length < 47 || address.length > 48) {
    return false;
  }
  // polkadot starts with 1, kusama with C/D/E/F/G/H/J
  const firstChar = address[0];
  return /^[1-9A-HJ-NP-Za-km-z]$/.test(firstChar ?? '');
}

/** convert planck to display amount */
export function formatBalance(planck: bigint, chain: SupportedChain): string {
  const info = CHAIN_INFO[chain];
  const value = Number(planck) / Math.pow(10, info.decimals);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${info.symbol}`;
}

/** convert display amount to planck */
export function parseAmount(display: string, chain: SupportedChain): bigint {
  const info = CHAIN_INFO[chain];
  const cleaned = display.replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  return BigInt(Math.floor(value * Math.pow(10, info.decimals)));
}
