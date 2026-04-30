/**
 * Multisig backup encryption helpers.
 *
 * Reuses @repo/encryption Key/Box/KeyPrint primitives (AES-GCM with
 * password-stretched key). The envelope is a flat JSON: plaintext
 * `label` + `publicKeyPackage` for identification, encrypted box for
 * the secret payload.
 */

import { Key } from '@repo/encryption/key';
import { KeyPrint, type KeyPrintJson } from '@repo/encryption/key-print';
import { Box, type BoxJson } from '@repo/encryption/box';

// ── plaintext payloads ──

export interface FrostSharePayload {
  version: 1;
  type: 'frost-share';
  label: string;
  publicKeyPackage: string;
  keyPackage: string;
  ephemeralSeed: string;
  threshold: number;
  maxSigners: number;
  mainnet: boolean;
  /** Orchard-only UFVK (`uview1…`) — saved so restore doesn't need the FVK sk. */
  orchardFvk: string;
  /** unified address — also derivable from publicKeyPackage + sk, saved for convenience. */
  address: string;
  /** relay url for FROST signing rounds. */
  relayUrl: string;
  createdAt: number;
}

export interface FrostShareBatchPayload {
  version: 1;
  type: 'frost-share-batch';
  shares: Omit<FrostSharePayload, 'version' | 'type'>[];
}

export type FrostBackupPayload = FrostSharePayload | FrostShareBatchPayload;

// ── envelope (the on-disk JSON shape) ──

export interface FrostBackupEnvelope {
  version: 1;
  /** `frost-share-backup` for single, `frost-share-batch-backup` for batch */
  type: 'frost-share-backup' | 'frost-share-batch-backup';
  /** plaintext label for backup-list identification (no secret leak) */
  label: string;
  /** plaintext publicKeyPackage for single backups; absent for batch */
  publicKeyPackage?: string;
  /** number of shares for batch backups; absent for single */
  shareCount?: number;
  /** when the export was made — plaintext, helps user identify */
  exportedAt: number;
  keyPrint: KeyPrintJson;
  box: BoxJson;
}

// ── operations ──

export const sealBackup = async (
  payload: FrostBackupPayload,
  passphrase: string,
  meta: { label: string; publicKeyPackage?: string; shareCount?: number },
): Promise<FrostBackupEnvelope> => {
  const { key, keyPrint } = await Key.create(passphrase);
  const box = await key.seal(JSON.stringify(payload));
  return {
    version: 1,
    type: payload.type === 'frost-share' ? 'frost-share-backup' : 'frost-share-batch-backup',
    label: meta.label,
    ...(meta.publicKeyPackage ? { publicKeyPackage: meta.publicKeyPackage } : {}),
    ...(meta.shareCount ? { shareCount: meta.shareCount } : {}),
    exportedAt: Date.now(),
    keyPrint: keyPrint.toJson(),
    box: box.toJson(),
  };
};

/** Returns null on wrong passphrase or tampered envelope. */
export const openBackup = async (
  envelope: FrostBackupEnvelope,
  passphrase: string,
): Promise<FrostBackupPayload | null> => {
  const key = await Key.recreate(passphrase, KeyPrint.fromJson(envelope.keyPrint));
  if (!key) return null;  // wrong passphrase

  const plaintext = await key.unseal(Box.fromJson(envelope.box));
  if (!plaintext) return null;  // tampered ciphertext

  try {
    const parsed = JSON.parse(plaintext) as FrostBackupPayload;
    if (parsed.version !== 1) return null;
    if (parsed.type !== 'frost-share' && parsed.type !== 'frost-share-batch') return null;
    return parsed;
  } catch {
    return null;
  }
};

/** parse a possibly-malformed JSON file as an envelope. returns null on bad shape. */
export const parseEnvelopeJson = (jsonText: string): FrostBackupEnvelope | null => {
  try {
    const parsed = JSON.parse(jsonText) as FrostBackupEnvelope;
    if (parsed.version !== 1) return null;
    if (parsed.type !== 'frost-share-backup' && parsed.type !== 'frost-share-batch-backup') return null;
    if (!parsed.keyPrint || !parsed.box) return null;
    return parsed;
  } catch {
    return null;
  }
};

/** sanitize label for filename: keep [A-Za-z0-9-_], replace others with '-' */
export const fileSafeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'multisig';

/** "frost-backup-treasury-20251201.json" */
export const backupFilename = (label: string, batch = false): string => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = batch ? 'frost-backup-all' : `frost-backup-${fileSafeLabel(label)}`;
  return `${prefix}-${ymd}.json`;
};
