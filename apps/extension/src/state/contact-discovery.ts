/**
 * Wallet-side private contact discovery - the bridge between the extension's
 * contact store and the @zafu/zid discovery layer.
 *
 * The SDK ships the whole protocol (rendezvous tags, presence blobs, the blind
 * relay client, the scheduler); the extension holds the ONLY thing the SDK must
 * not have - the mnemonic-derived pairwise contact secrets. This module joins
 * them: it turns wallet contacts into the SDK's `DiscoveryPeer`s (deriving each
 * root secret ONCE, suite-blind from here on), runs discovery for one app scope,
 * and builds this wallet's own presence record (published by
 * ./discovery-presence, only for a granted site whose page is open).
 *
 * PRIVACY INVARIANTS (do not weaken):
 *   - a root secret is established ONCE and cached for the session; it is never
 *     persisted (it is long-term key material - see packages/zid/src/contacts.ts
 *     for the same reasoning) and never returned or logged;
 *   - discovery runs PER RELATIONSHIP: the secret comes from the KA key you
 *     gave that one person and the one they gave you, so no key is shared
 *     between two people's cards. A contact without both relationship cards
 *     (address only, an older card, or yours not given yet) is SKIPPED, never
 *     a hard failure - discovery is best-effort and simply unavailable for it
 *     until cards are exchanged;
 *   - the handle an app sees is derived from that secret, never from a public
 *     key, so holding someone's card does not let a site test for them;
 *   - the app-facing result is ONLY `{ handle, sessionPubHex, caps }` - never the
 *     contact list, an absent contact, a raw peer pubkey, or the root secret.
 */

import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import {
  ContactRelay,
  PRESENCE_BLOB_BYTES,
  PRESENCE_PAD_TO,
  createPresenceService,
  discoverContacts as discoverPresentContacts,
  type DiscoveryPeer,
  type PresenceRecord,
  type RelayTransport,
} from '@zafu/zid';
import type { ZafuDiscoveredContact } from '@zafu/protocol';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { deriveRelationshipKeys, discoverySecret, xidOf } from './identity';
import { isMutual, type Contact } from './contacts';

/**
 * Capability/status bits advertised in this wallet's presence record. No bits
 * are defined yet, so a present peer is a peer and nothing more; the field is
 * carried so a later version can advertise e.g. "accepts invites" without a
 * wire change.
 */
export const CONTACT_DISCOVERY_CAPS = 0;

/**
 * Session-scoped cache of pairwise root secrets. IN-MEMORY by design (never
 * persisted): the secret is a long-term shared secret, and this mirrors the
 * SDK's own choice in packages/zid/src/contacts.ts. `link` records the
 * relationship and the peer keys the secret was made from, so a peer who
 * handed you a NEW card invalidates the stale secret instead of silently
 * beaconing to a dead tag.
 */
const rootSecretCache = new Map<string, { link: string; peer: DiscoveryPeerKeys }>();

/**
 * Per-(app scope, epoch) ephemeral session keypair. The public half is what this
 * wallet advertises in its presence record; the private half stays in the
 * worker so a peer that dials the advertised pubkey can later be answered. Only
 * the current epoch is kept per scope (older epochs are dead).
 */
const sessionKeyCache = new Map<string, Uint8Array>();

/** one relationship's discovery material: the secret, and both KA public keys */
export interface DiscoveryPeerKeys {
  secret: Uint8Array;
  /** the KA key you gave this person (it names you in the rendezvous tag) */
  myPubHex: string;
  /** the KA key they gave you */
  friendPubHex: string;
}

/**
 * App-scoped opaque handle for a contact: HKDF of the relationship's own
 * discovery secret, bound to the app scope. Deterministic per contact and app,
 * unlinkable across apps, and computable only by the two people in the
 * relationship. It used to be a hash of the contact's PUBLIC card key, which let
 * anyone who held that card (a site's operator included) test whether a visitor
 * had this person as a contact.
 */
export const computeContactHandle = (secret: Uint8Array, appScope: string): string =>
  bytesToHex(
    hkdf(
      sha256,
      secret,
      undefined,
      new Uint8Array([
        ...new TextEncoder().encode('zid-contact-handle-v1'),
        ...sha256(new TextEncoder().encode(appScope)),
      ]),
      32,
    ),
  );

/**
 * Establish (once) and cache each discovery-capable contact's pairwise secret,
 * returning contactId -> keys. A contact is discovery-capable when the two of
 * you hold each other's relationship cards (`isMutual`): your relationship
 * (`rel`, on this wallet) and their card's inception and pair-KA keys. The
 * secret is X25519 between your relationship KA key and theirs, so every
 * person sees a different key from you and no two cards link.
 *
 * Everyone else is omitted, not an error: an address-only contact, one saved
 * from an older card (which carried one identity-wide key and no pair key),
 * or one you have not given your card yet. They are simply not discoverable
 * until cards are exchanged. Secrets for contacts that vanished or changed
 * are zeroized and dropped.
 */
export const deriveContactRootSecrets = (
  contacts: readonly Contact[],
  mnemonic: string,
  walletId: string,
): Map<string, DiscoveryPeerKeys> => {
  const out = new Map<string, DiscoveryPeerKeys>();
  const liveIds = new Set<string>();
  for (const contact of contacts) {
    if (!isMutual(contact, walletId)) {
      continue;
    }
    const { rel, pairKa, zid } = contact as Required<Pick<Contact, 'rel' | 'pairKa' | 'zid'>>;
    liveIds.add(contact.id);
    const link = `${rel.walletId}:${rel.gen}:${rel.j}:${pairKa}:${zid}`;
    const cached = rootSecretCache.get(contact.id);
    if (cached?.link === link) {
      out.set(contact.id, cached.peer);
      continue;
    }
    cached?.peer.secret.fill(0); // a new card - the old secret is dead
    try {
      const keys = deriveRelationshipKeys(mnemonic, rel.gen, rel.j);
      try {
        const peer: DiscoveryPeerKeys = {
          secret: discoverySecret(keys.kaSeed, pairKa, keys.xid, xidOf(zid)),
          myPubHex: keys.kaPublicKey,
          friendPubHex: pairKa,
        };
        rootSecretCache.set(contact.id, { link, peer });
        out.set(contact.id, peer);
      } finally {
        keys.seed.fill(0);
        keys.kaSeed.fill(0);
        keys.xwingSeed.fill(0);
      }
    } catch {
      // a malformed stored key: fail closed for this contact only
      rootSecretCache.delete(contact.id);
    }
  }
  for (const [id, entry] of rootSecretCache) {
    if (!liveIds.has(id)) {
      entry.peer.secret.fill(0);
      rootSecretCache.delete(id);
    }
  }
  return out;
};

/**
 * Map wallet contacts to the SDK's discovery peers for one app scope. `id` is
 * the app-scoped handle (the only thing the app ever sees), `friendPubHex` the
 * KA key they gave you, `myPubHex` the one you gave them, and `rootSecret` the
 * cached pairwise secret.
 */
export const buildDiscoveryPeers = (
  contacts: readonly Contact[],
  appScope: string,
  secrets: ReadonlyMap<string, DiscoveryPeerKeys>,
): DiscoveryPeer[] =>
  contacts.flatMap(contact => {
    const k = secrets.get(contact.id);
    return k
      ? [
          {
            id: computeContactHandle(k.secret, appScope),
            friendPubHex: k.friendPubHex,
            myPubHex: k.myPubHex,
            rootSecret: k.secret,
          },
        ]
      : [];
  });

/** the SDK's blind-relay client configured for one app scope, with the
 *  protocol-global padding/blob constants (never per-user values - a differing
 *  write size would leak the friend count the padding exists to hide). */
export const createContactRelay = (transport: RelayTransport, appScope: string): ContactRelay =>
  new ContactRelay(transport, {
    appOrigin: appScope,
    padTo: PRESENCE_PAD_TO,
    blobBytes: PRESENCE_BLOB_BYTES,
  });

/**
 * Discover which of the wallet's contacts are present in `appScope` this epoch.
 * Returns the app-facing intersection only - see the module header's privacy
 * invariants. Never includes an absent contact or a raw pubkey.
 */
export const discoverForScope = async (args: {
  appScope: string;
  contacts: readonly Contact[];
  mnemonic: string;
  walletId: string;
  transport: RelayTransport;
}): Promise<ZafuDiscoveredContact[]> => {
  const secrets = deriveContactRootSecrets(args.contacts, args.mnemonic, args.walletId);
  const peers = buildDiscoveryPeers(args.contacts, args.appScope, secrets);
  // every peer carries the key you gave that person: there is no wallet-wide one
  const service = createPresenceService(
    createContactRelay(args.transport, args.appScope),
    args.appScope,
  );
  const present = await discoverPresentContacts(service, peers);
  return present.map(p => ({ handle: p.id, sessionPubHex: p.sessionPubHex, caps: p.caps }));
};

/** the ephemeral session pubkey this wallet advertises for `(appScope, epoch)`,
 *  generating and retaining the matching private key for the epoch. */
const sessionPubFor = (appScope: string, epoch: number): Uint8Array => {
  const key = `${appScope}|${epoch}`;
  const cached = sessionKeyCache.get(key);
  if (cached) {
    return x25519.getPublicKey(cached);
  }
  for (const [k, priv] of sessionKeyCache) {
    if (k.startsWith(`${appScope}|`) && k !== key) {
      priv.fill(0); // previous epochs are dead
      sessionKeyCache.delete(k);
    }
  }
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  sessionKeyCache.set(key, privateKey);
  return x25519.getPublicKey(privateKey);
};

/**
 * The presence record this wallet advertises for `(appScope, epoch)`: the
 * app-scoped ephemeral session pubkey plus the capability bits. Built on demand
 * (once per epoch) rather than stored, so nothing about the epoch survives in
 * memory beyond the session key it holds.
 */
export const buildPresenceRecord = (appScope: string, epoch: number): PresenceRecord => ({
  sessionPub: sessionPubFor(appScope, epoch),
  caps: CONTACT_DISCOVERY_CAPS,
});
