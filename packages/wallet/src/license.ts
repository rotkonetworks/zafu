/**
 * license — ZEC-paid pro subscription verified via ZID + rotko signature.
 *
 * flow:
 * 1. user sends 0.01 ZEC to rotko's address with memo "zid<pubkey>"
 * 2. zidecar detects payment, signs license: { zid, expires, plan }
 * 3. zafu fetches/stores license, checks expiry for feature gating
 *
 * no accounts, no emails, no KYC. blockchain = payment ledger, ZID = account.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes } from '@noble/hashes/utils';
import { ROTKO_ZCASH_VERIFIER } from './rotko-verifier';

/** license plans */
export type Plan = 'free' | 'pro';

/** signed license from rotko */
export interface License {
  /** ZID public key (hex) */
  zid: string;
  /** plan name */
  plan: Plan;
  /** expiry unix timestamp (seconds) */
  expires: number;
  /** rotko ed25519 signature over the license payload */
  signature: string;
}

/** base rate: 1,000,000 zat (0.01 ZEC) = 30 days */
export const PRO_RATE_ZAT_PER_30_DAYS = 1_000_000;

/** calculate days of pro time for a given payment amount */
export function daysForPayment(amountZat: number): number {
  return Math.floor((amountZat / PRO_RATE_ZAT_PER_30_DAYS) * 30);
}

/** rotko's receiving address for license payments */
export const ROTKO_LICENSE_ADDRESS = 'u153khs43zxz6hcnlwnut77knyqmursnutmungxjxd7khruunhj77ea6tmpzxct9wzlgen66jxwc93ea053j22afkktu7hrs9rmsz003h3';

/** features gated behind pro */
export const PRO_FEATURES = [
  'passwords',
  'passkeys',
  'frost_multisig',
  'multiple_identities',
  'zigner_cold_signing',
  'encrypted_backup',
  'extended_relay_ttl',
  'inbox_send',
] as const;

export type ProFeature = typeof PRO_FEATURES[number];

/**
 * build the license payload that gets signed.
 * format: "zafu-license-v1\n{zid}\n{plan}\n{expires}"
 */
export function licensePayload(zid: string, plan: Plan, expires: number): Uint8Array {
  return new TextEncoder().encode(`zafu-license-v1\n${zid}\n${plan}\n${expires}`);
}

/**
 * verify a license signature against rotko's public key.
 */
export function verifyLicense(license: License): boolean {
  if (!license.zid || !license.signature || !license.expires) return false;

  const verifierKey = hexToBytes(ROTKO_ZCASH_VERIFIER);
  if (verifierKey.every(b => b === 0)) return false; // placeholder key

  const payload = licensePayload(license.zid, license.plan, license.expires);
  const sig = hexToBytes(license.signature);

  try {
    return ed25519.verify(sig, payload, verifierKey);
  } catch {
    return false;
  }
}

/**
 * check if a license is valid (signature + not expired).
 */
export function isLicenseValid(license: License | null | undefined): boolean {
  if (!license) return false;
  if (!verifyLicense(license)) return false;
  return license.expires > Date.now() / 1000;
}

/**
 * check if a specific pro feature is available.
 */
export function hasProFeature(license: License | null | undefined, _feature: ProFeature): boolean {
  if (!isLicenseValid(license)) return false;
  return license!.plan === 'pro';
}

/**
 * build the memo string for a license payment.
 * user sends this as the Zcash memo when paying.
 */
export function buildPaymentMemo(zidPubkey: string): string {
  return `zid${zidPubkey}`;
}

/**
 * parse a license from JSON (stored in localStorage).
 */
export function parseLicense(json: string): License | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj.zid === 'string' && typeof obj.expires === 'number' && typeof obj.signature === 'string') {
      return obj as License;
    }
  } catch { /* */ }
  return null;
}

/**
 * days remaining on license (0 if expired).
 */
export function daysRemaining(license: License | null | undefined): number {
  if (!license) return 0;
  const secs = license.expires - Date.now() / 1000;
  return Math.max(0, Math.ceil(secs / 86400));
}
