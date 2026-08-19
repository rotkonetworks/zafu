/**
 * PresenceService — the composition that turns the ZID contact-discovery
 * primitives into a usable "publish my presence / find present friends" service.
 *
 * It ties together, for one app scope:
 *   - contact-discovery.ts : the per-epoch rendezvous tag
 *   - presence-blob.ts     : the AEAD presence blob
 *   - contact-relay.ts     : the blind relay + broadcast-bucket mitigation
 *
 * It is deliberately decoupled from the extension: callers pass each peer with
 * its already-resolved pairwise `rootSecret` (established + cached in
 * contacts.ts via an extension-injected derive-fn), so the mnemonic never
 * crosses into this SDK. Suite-blind throughout — the secret is opaque bytes.
 *
 * Direction: to announce MYSELF to peer j I publish under a tag derived with MY
 * pubkey (that is the direction `rendezvousTag` encodes), and seal the blob in
 * the `a2b`/`b2a` direction fixed by the lexicographic order of the pair — both
 * sides compute the same direction independently.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { presenceEpoch, rendezvousTag } from './contact-discovery';
import {
  sealPresence,
  openPresence,
  encodePresenceRecord,
  decodePresenceRecord,
  type PresenceRecord,
  type PresenceDir,
} from './presence-blob';
import type { ContactRelay, PresenceEntry, FriendPresenceQuery } from './contact-relay';

/** a friend to publish-to / discover, with the cached pairwise root secret. */
export interface DiscoveryPeer {
  /** caller's stable handle for the peer (echoed back). */
  id: string;
  /** the peer's contact-card key-agreement public key (hex). */
  friendPubHex: string;
  /** the cached pairwise root secret (from contacts.ts establishContactSecret). */
  rootSecret: Uint8Array;
}

/** a present friend, with their decrypted presence record. */
export interface PresentPeer {
  id: string;
  record: PresenceRecord;
}

/** the a2b/b2a direction for a pair, fixed by lexicographic pubkey order so both
 *  peers derive it identically regardless of who is publishing. */
const pairDir = (publisherPubHex: string, recipientPubHex: string): PresenceDir =>
  publisherPubHex <= recipientPubHex ? 'a2b' : 'b2a';

export interface PresenceService {
  /**
   * Publish MY presence to each peer for this epoch. One padded, fixed-cadence
   * relay write (the relay can't tell how many friends I have — see ContactRelay).
   * The relay MUST be configured with `blobBytes` equal to the sealed blob size
   * for a PresenceRecord (else publish fails loudly).
   */
  publishSelf(
    record: PresenceRecord,
    peers: readonly DiscoveryPeer[],
    epoch?: number,
  ): Promise<void>;
  /**
   * Find which peers are present this epoch: one whole-bucket fetch, local match,
   * then AEAD-open each match. Non-friends and forged tags open to null and are
   * dropped.
   */
  findPresent(peers: readonly DiscoveryPeer[], epoch?: number): Promise<PresentPeer[]>;
}

/**
 * @param relay      a ContactRelay configured with THIS `appOrigin` and a
 *                   `blobBytes` matching the sealed PresenceRecord size.
 * @param appOrigin  the app scope; MUST equal the relay's appOrigin so tags and
 *                   buckets agree.
 * @param myPubHex   my own contact-card key-agreement public key (hex).
 */
export const createPresenceService = (
  relay: ContactRelay,
  appOrigin: string,
  myPubHex: string,
): PresenceService => ({
  async publishSelf(record, peers, epoch = presenceEpoch()) {
    const plaintext = encodePresenceRecord(record);
    const entries: PresenceEntry[] = [];
    for (const p of peers) {
      // I announce under MY pubkey; peer j finds me by deriving the same tag.
      const tag = rendezvousTag(p.rootSecret, appOrigin, epoch, myPubHex);
      const blob = await sealPresence(
        p.rootSecret,
        appOrigin,
        epoch,
        pairDir(myPubHex, p.friendPubHex),
        plaintext,
      );
      entries.push({ tag, blob });
    }
    await relay.publishPresence(entries, epoch);
  },

  async findPresent(peers, epoch = presenceEpoch()) {
    const queries: FriendPresenceQuery[] = peers.map(p => ({
      id: p.id,
      friendPubHex: p.friendPubHex,
      rootSecret: p.rootSecret,
    }));
    const present = await relay.discover(queries, epoch);
    const byId = new Map(peers.map(p => [p.id, p]));
    const out: PresentPeer[] = [];
    for (const f of present) {
      const p = byId.get(f.id);
      if (!p) {
        continue;
      }
      // the peer published (to me) under THEIR pubkey; open in that direction.
      const bytes = await openPresence(
        p.rootSecret,
        appOrigin,
        epoch,
        pairDir(p.friendPubHex, myPubHex),
        f.blob,
      );
      if (bytes) {
        out.push({ id: f.id, record: decodePresenceRecord(bytes) });
      }
    }
    return out;
  },
});

/** the minimum an app receives per present contact: the caller's handle, the
 *  peer's EPHEMERAL session pubkey (to connect to), and capability bits. Never
 *  the pairwise root secret, the contact card, or anything about non-present
 *  contacts. */
export interface DiscoveredContact {
  id: string;
  sessionPubHex: string;
  caps: number;
}

/**
 * App-facing contact discovery — the response contract for the
 * `zafu_discover_contacts` external primitive.
 *
 * Given the set of the user's contacts (already resolved to pairwise root
 * secrets by the extension), return ONLY the ones present in this app scope this
 * epoch, each reduced to the minimum an app needs to connect. A web app learns
 * nothing about contacts who are absent — the full social graph never crosses
 * the boundary, only the present intersection.
 */
export const discoverContacts = async (
  service: PresenceService,
  peers: readonly DiscoveryPeer[],
  epoch?: number,
): Promise<DiscoveredContact[]> =>
  (await service.findPresent(peers, epoch)).map(p => ({
    id: p.id,
    sessionPubHex: bytesToHex(p.record.sessionPub),
    caps: p.record.caps,
  }));
