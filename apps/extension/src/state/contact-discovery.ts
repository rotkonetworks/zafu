/**
 * Wallet-side private contact discovery - the bridge between the extension's
 * contact store and the @zafu/zid discovery layer.
 *
 * The SDK ships the whole protocol (rendezvous tags, presence blobs, the blind
 * relay client, the scheduler); the extension holds the ONLY thing the SDK must
 * not have - the mnemonic-derived pairwise contact secrets. This module joins
 * them: it turns wallet contacts into the SDK's `DiscoveryPeer`s (deriving each
 * root secret ONCE, suite-blind from here on), runs discovery for one app scope,
 * and publishes this wallet's own presence for the fixed-cadence alarm.
 *
 * PRIVACY INVARIANTS (do not weaken):
 *   - a root secret is established ONCE and cached for the session; it is never
 *     persisted (it is long-term key material - see packages/zid/src/contacts.ts
 *     for the same reasoning) and never returned or logged;
 *   - a legacy contact (no `card`) is SKIPPED, never a hard failure - discovery
 *     is best-effort and simply unavailable for it until the relationship is
 *     re-exchanged with a card;
 *   - a contact whose card names an unknown/unsupported KA suite is skipped too
 *     (fail closed for that contact, not for the whole request);
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
  type PublishArgs,
  type RelayTransport,
} from '@zafu/zid';
import type { ZafuDiscoveredContact } from '@zafu/protocol';
import { deriveZidContactCardKey, zidContactRootSecret } from './identity';
import type { Contact } from './contacts';

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
 * SDK's own choice in packages/zid/src/contacts.ts. `cardIdentity` records the
 * card the secret was established from, so a peer who ROTATED their card
 * invalidates the stale secret instead of silently beaconing to a dead tag.
 */
const rootSecretCache = new Map<string, { cardIdentity: string; secret: Uint8Array }>();

/**
 * Per-(app scope, epoch) ephemeral session keypair. The public half is what this
 * wallet advertises in its presence record; the private half stays in the
 * worker so a peer that dials the advertised pubkey can later be answered. Only
 * the current epoch is kept per scope (older epochs are dead).
 */
const sessionKeyCache = new Map<string, Uint8Array>();

/** app-scoped opaque handle for a contact, matching the SDK's derivation:
 *  SHA-256("<pubkey>:<appScope>:zid:contact:v1"). Deterministic per contact+app,
 *  unlinkable across apps, and never the raw pubkey. */
export const computeContactHandle = async (pubkey: string, appScope: string): Promise<string> => {
  const input = new TextEncoder().encode(`${pubkey}:${appScope}:zid:contact:v1`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return bytesToHex(hash);
};

/** the identity of the card a secret was established from (suite + public key). */
const cardIdentity = (suite: string, publicKey: string): string => `${suite}:${publicKey}`;

/**
 * Establish (once) and cache each discovery-capable contact's pairwise root
 * secret, returning contactId -> secret. Contacts without a `card` (legacy) and
 * contacts whose card names an unsupported suite are omitted - they are not
 * errors, they are simply not discoverable. Secrets for contacts that vanished
 * or lost their card are zeroized and dropped.
 */
export const deriveContactRootSecrets = (
  contacts: readonly Contact[],
  mnemonic: string,
  identityName: string,
): Map<string, Uint8Array> => {
  const secrets = new Map<string, Uint8Array>();
  const liveIds = new Set<string>();
  for (const contact of contacts) {
    const card = contact.card;
    if (!card) {
      continue; // legacy contact - discovery unavailable, fail soft
    }
    liveIds.add(contact.id);
    const identity = cardIdentity(card.suite, card.publicKey);
    const cached = rootSecretCache.get(contact.id);
    if (cached && cached.cardIdentity === identity) {
      secrets.set(contact.id, cached.secret);
      continue;
    }
    if (cached) {
      cached.secret.fill(0); // rotated card - the old secret is dead
    }
    try {
      // may throw on an unknown/unsupported suite - fail closed for this
      // contact only; nothing is cached.
      const secret = zidContactRootSecret(mnemonic, identityName, card);
      rootSecretCache.set(contact.id, { cardIdentity: identity, secret });
      secrets.set(contact.id, secret);
    } catch {
      rootSecretCache.delete(contact.id);
    }
  }
  for (const [id, entry] of rootSecretCache) {
    if (!liveIds.has(id)) {
      entry.secret.fill(0);
      rootSecretCache.delete(id);
    }
  }
  return secrets;
};

/**
 * Map wallet contacts to the SDK's discovery peers for one app scope. `id` is
 * the app-scoped handle (the only thing the app ever sees); `friendPubHex` is
 * the peer's contact-card key and `rootSecret` the cached pairwise secret.
 */
export const buildDiscoveryPeers = async (
  contacts: readonly Contact[],
  appScope: string,
  secrets: ReadonlyMap<string, Uint8Array>,
): Promise<DiscoveryPeer[]> => {
  const peers: DiscoveryPeer[] = [];
  for (const contact of contacts) {
    const card = contact.card;
    const secret = secrets.get(contact.id);
    if (!card || !secret) {
      continue;
    }
    peers.push({
      id: await computeContactHandle(card.publicKey, appScope),
      friendPubHex: card.publicKey,
      rootSecret: secret,
    });
  }
  return peers;
};

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
  identityName: string;
  transport: RelayTransport;
}): Promise<ZafuDiscoveredContact[]> => {
  const secrets = deriveContactRootSecrets(args.contacts, args.mnemonic, args.identityName);
  const peers = await buildDiscoveryPeers(args.contacts, args.appScope, secrets);
  const service = createPresenceService(
    createContactRelay(args.transport, args.appScope),
    args.appScope,
    deriveZidContactCardKey(args.mnemonic, args.identityName).publicKey,
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

/**
 * What this wallet should publish for `(appScope, epoch)`: the presence record
 * (a fresh app-scoped ephemeral session pubkey) and the peers to beacon to.
 * With zero discovery-capable contacts `peers` is empty - the SDK still writes
 * a padded, constant-shape bucket (fixed cadence), so "went quiet" is not
 * observable. The cadence itself is the scheduler's job (see
 * state/contact-discovery-service).
 */
export const buildPublishArgs = async (args: {
  appScope: string;
  contacts: readonly Contact[];
  mnemonic: string;
  identityName: string;
  epoch: number;
}): Promise<PublishArgs> => {
  const secrets = deriveContactRootSecrets(args.contacts, args.mnemonic, args.identityName);
  const peers = await buildDiscoveryPeers(args.contacts, args.appScope, secrets);
  return { record: buildPresenceRecord(args.appScope, args.epoch), peers };
};
