/**
 * Read + decrypt FROST backup files. After decrypt, hands plaintext
 * payloads to keyRing.newFrostMultisigKey. Skips wallets whose
 * publicKeyPackage already exists; returns counts so the UI can summarize.
 */

import { useStore } from '../../../../state';
import { selectMultisigWallets } from '../../../../state/wallets';
import {
  openBackup,
  parseEnvelopeJson,
  type FrostBackupEnvelope,
  type FrostBackupPayload,
  type FrostSharePayload,
} from '../../../../state/keyring/multisig-backup';
import type { SeatRoom } from '../../../../state/keyring/vault-ops';
import { readRooms } from '../../../../people/vault';

export interface ImportSummary {
  imported: number;
  skipped: number;
  total: number;
}

const importOneShare = async (
  share: Omit<FrostSharePayload, 'version' | 'type'>,
): Promise<'imported' | 'skipped'> => {
  const existing = selectMultisigWallets(useStore.getState());
  if (existing.some(w => w.multisig?.publicKeyPackage === share.publicKeyPackage)) {
    return 'skipped';
  }
  await useStore.getState().keyRing.newFrostMultisigKey({
    ...(share.room ? { room: await roomHere(share.room) } : {}),
    label: share.label,
    address: share.address,
    orchardFvk: share.orchardFvk,
    publicKeyPackage: share.publicKeyPackage,
    threshold: share.threshold,
    maxSigners: share.maxSigners,
    relayUrl: share.relayUrl,
    custody: 'self',
    keyPackage: share.keyPackage,
    ephemeralSeed: share.ephemeralSeed,
  });
  // it came from an encrypted backup file, so that file is its backup
  const restored = selectMultisigWallets(useStore.getState()).find(
    w => w.multisig?.publicKeyPackage === share.publicKeyPackage,
  );
  if (restored) {
    await useStore
      .getState()
      .wallets.updateMultisigWallet(restored.id, { backedUpAt: share.createdAt || Date.now() });
  }
  return 'imported';
};

/**
 * A seat's room as this zafu holds it: the people backup may have put the
 * room under another wallet id than the one the seat was made under, so the
 * seat follows the room.
 */
const roomHere = async (room: SeatRoom): Promise<SeatRoom> => {
  const here = (await readRooms())?.find(r => r.id === room.roomId);
  return here ? { ...room, walletId: here.walletId } : room;
};

export const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("this file didn't open"));
    reader.readAsText(file);
  });

/** parse the file as an envelope. throws if not a valid backup file. */
export const readEnvelopeFromFile = async (file: File): Promise<FrostBackupEnvelope> => {
  const text = await readFileAsText(file);
  const env = parseEnvelopeJson(text);
  if (!env) {
    throw new Error("this doesn't look like a multisig backup");
  }
  return env;
};

/** decrypt envelope and import every share inside (single or batch). */
export const importBackup = async (
  envelope: FrostBackupEnvelope,
  passphrase: string,
): Promise<ImportSummary> => {
  const payload: FrostBackupPayload | null = await openBackup(envelope, passphrase);
  if (!payload) {
    throw new Error("that passphrase doesn't open this backup");
  }

  const shares =
    payload.type === 'frost-share'
      ? [
          {
            label: payload.label,
            publicKeyPackage: payload.publicKeyPackage,
            keyPackage: payload.keyPackage,
            ephemeralSeed: payload.ephemeralSeed,
            threshold: payload.threshold,
            maxSigners: payload.maxSigners,
            mainnet: payload.mainnet,
            orchardFvk: payload.orchardFvk,
            address: payload.address,
            relayUrl: payload.relayUrl,
            createdAt: payload.createdAt,
            room: payload.room,
          },
        ]
      : payload.shares;

  let imported = 0;
  let skipped = 0;
  for (const share of shares) {
    const r = await importOneShare(share);
    if (r === 'imported') {
      imported++;
    } else {
      skipped++;
    }
  }
  return { imported, skipped, total: shares.length };
};
