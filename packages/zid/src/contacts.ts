/**
 * zid contacts — local contact store with app-scoped handles
 *
 * contacts live in localStorage, managed by zid independently.
 * when zafu is connected, contacts can be imported from the wallet.
 * handles are BLAKE2b(contact_pubkey || app_origin || "zid:contact:v1")
 * — deterministic per contact+app, unlinkable across apps.
 */

import type { ContactCardKey, ContactRef, ContactShare } from './types';

const STORAGE_KEY = 'zid_contacts';

/** internal contact record */
interface StoredContact {
  /** session pubkey of this contact */
  pubkey: string;
  /** display name (user-chosen) */
  name: string;
  /** when we first saw them */
  addedAt: number;
  /** last interaction */
  lastSeenAt: number;
  /** app-scoped handle (computed on first use per app) */
  handles: Record<string, string>; // appOrigin → handle
  /**
   * peer's contact-card key-agreement key, for private contact discovery.
   *
   * OPTIONAL by design — this IS the legacy-contact migration. Contacts added
   * before discovery existed simply have no `card`; they load unchanged and
   * discovery is silently unavailable for them (see `establishContactSecret`),
   * no crash. They gain it only when the relationship is re-exchanged.
   *
   * The `card.suite` is stored VERBATIM (wide `string`): an unknown future
   * suite round-trips at rest and only fails closed when someone establishes a
   * secret with it.
   */
  card?: ContactCardKey;
}

// ---------------------------------------------------------------------------
// pairwise root-secret cache (sensitive key material)
// ---------------------------------------------------------------------------
//
// The pairwise root secret must be ESTABLISHED ONCE and CACHED: a future KEM
// suite is not a non-interactive DH, so it can't be recomputed on demand.
//
// STORAGE CHOICE — deliberately IN-MEMORY (module scope), NOT localStorage.
// The contact records above live in localStorage as plaintext, but they hold
// only PUBLIC material (pubkeys, cards, handles). The root secret is a
// long-term shared secret; persisting it as plaintext would be a real
// regression. This matches the extension's ZID pattern (state/identity.ts):
// secrets are derived on demand and zeroized, never written to disk.
//
// LIFETIME: the current JS context / session. On the next session the secret
// is re-established from the persisted peer `card` — deterministic and cheap
// for the 'x25519-v1' (static-static DH) suite.
//
// MIGRATION CAVEAT (future PQ suites): a KEM suite CANNOT be re-established
// non-interactively from the card alone. When such a suite ships, this cache
// must move to persistent ENCRYPTED storage on the extension side
// (apps/extension/src/state/encrypted-storage.ts), not here. Documented so the
// swap is localized to establishment, exactly as identity.ts intends.
const rootSecretCache = new Map<string, Uint8Array>(); // pubkey → root secret bytes

const copyBytes = (b: Uint8Array): Uint8Array => Uint8Array.from(b);

/** compute app-scoped handle via SHA-256 (BLAKE2b not in Web Crypto, SHA-256 is fine) */
async function computeHandle(pubkey: string, appOrigin: string): Promise<string> {
  const input = new TextEncoder().encode(`${pubkey}:${appOrigin}:zid:contact:v1`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function loadContacts(): StoredContact[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveContacts(contacts: StoredContact[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
}

/**
 * add or update a contact (called when you interact with someone).
 *
 * `card` (optional, trailing) carries the peer's contact-card key-agreement key
 * so private discovery can establish a pairwise secret later. Omitting it keeps
 * the pre-discovery behavior byte-for-byte; passing it on an existing contact
 * upgrades a legacy record in place. A newly-supplied card that differs from the
 * cached one invalidates the stale root secret (the peer rotated their KA key).
 */
export function upsertContact(pubkey: string, name: string, card?: ContactCardKey) {
  const contacts = loadContacts();
  const existing = contacts.find(c => c.pubkey === pubkey);
  if (existing) {
    existing.name = name;
    existing.lastSeenAt = Date.now();
    if (card) {
      const changed =
        existing.card?.suite !== card.suite || existing.card?.publicKey !== card.publicKey;
      if (changed) {
        forgetRootSecret(pubkey);
      }
      existing.card = card;
    }
  } else {
    contacts.push({
      pubkey,
      name,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
      handles: {},
      ...(card ? { card } : {}),
    });
  }
  saveContacts(contacts);
}

/** zeroize and drop any cached root secret for a contact. */
function forgetRootSecret(pubkey: string) {
  const secret = rootSecretCache.get(pubkey);
  if (secret) {
    secret.fill(0);
    rootSecretCache.delete(pubkey);
  }
}

/** remove a contact (also wipes any cached pairwise secret). */
export function removeContact(pubkey: string) {
  forgetRootSecret(pubkey);
  const contacts = loadContacts().filter(c => c.pubkey !== pubkey);
  saveContacts(contacts);
}

/**
 * Establish (once) and cache the pairwise ROOT SECRET for a contact, then return
 * a copy for immediate use. The discovery layer feeds this secret to
 * `rendezvousTag` (contact-discovery.ts); the secret itself is suite-blind bytes.
 *
 * `deriveRootSecret` is INJECTED by the extension side (the only place that holds
 * the mnemonic): compose it as `card => zidContactRootSecret(mnemonic, identity,
 * card)`. This SDK stays suite-blind and never imports extension state — the
 * mnemonic never crosses into DApp-shipped code.
 *
 * Semantics:
 *   - legacy contact (no `card`)  → returns `null`, no crash (discovery simply
 *     unavailable until the relationship is re-exchanged with a card).
 *   - already established         → returns the cached secret WITHOUT calling
 *     `deriveRootSecret` again ("establish once").
 *   - unknown / unsupported suite → `deriveRootSecret` throws (fail-closed); the
 *     error propagates and NOTHING is cached.
 *
 * The returned bytes are a COPY the caller owns and should zeroize; the cache
 * keeps its own copy for the session.
 */
export function establishContactSecret(
  pubkey: string,
  deriveRootSecret: (card: ContactCardKey) => Uint8Array,
): Uint8Array | null {
  const cached = rootSecretCache.get(pubkey);
  if (cached) {
    return copyBytes(cached);
  }
  const contact = loadContacts().find(c => c.pubkey === pubkey);
  if (!contact?.card) {
    return null; // legacy or unknown contact — discovery unavailable, fail soft
  }
  // may throw on an unknown/unsupported suite — fail closed, cache nothing.
  const secret = deriveRootSecret(contact.card);
  rootSecretCache.set(pubkey, secret); // cache owns these bytes for the session
  return copyBytes(secret);
}

/**
 * Return a copy of the cached pairwise root secret for a contact, or `null` if
 * none has been established this session. For the discovery layer to derive
 * rendezvous tags. Caller owns the copy and should zeroize it.
 */
export function getContactRootSecret(pubkey: string): Uint8Array | null {
  const secret = rootSecretCache.get(pubkey);
  return secret ? copyBytes(secret) : null;
}

/** get all contacts as ContactRefs for a given app */
export async function getContactRefs(appOrigin: string): Promise<ContactRef[]> {
  const contacts = loadContacts();
  const refs: ContactRef[] = [];
  for (const c of contacts) {
    if (!c.handles[appOrigin]) {
      c.handles[appOrigin] = await computeHandle(c.pubkey, appOrigin);
    }
    refs.push({ handle: c.handles[appOrigin], displayName: c.name });
  }
  saveContacts(contacts); // persist computed handles
  return refs;
}

/** resolve a handle back to a pubkey (only works within the same app) */
export function resolveHandle(handle: string, appOrigin: string): string | null {
  const contacts = loadContacts();
  for (const c of contacts) {
    if (c.handles[appOrigin] === handle) return c.pubkey;
  }
  return null;
}

/** get recent contacts (sorted by lastSeenAt) */
export async function getRecentContacts(appOrigin: string, limit = 10): Promise<ContactRef[]> {
  const contacts = loadContacts()
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit);
  const refs: ContactRef[] = [];
  for (const c of contacts) {
    if (!c.handles[appOrigin]) {
      c.handles[appOrigin] = await computeHandle(c.pubkey, appOrigin);
    }
    refs.push({ handle: c.handles[appOrigin], displayName: c.name });
  }
  return refs;
}

/** picker: show a simple prompt-based picker (real UI would be in-page component) */
export async function pickFromLocal(
  appOrigin: string,
  opts: { purpose?: string; max?: number } = {},
): Promise<ContactRef[]> {
  const all = await getContactRefs(appOrigin);
  if (all.length === 0) return [];
  // in a real implementation this would open a modal/popup
  // for now, return all contacts (the app's UI handles selection)
  return all.slice(0, opts.max || 1);
}

/**
 * import contacts from the zafu wallet (if connected).
 *
 * Each entry is a `ContactShare` — pubkey, name, and (for discovery) the peer's
 * `card`. This is also the shape a peer uses to add YOU: the wallet builds its
 * own share as `{ pubkey, name, card: deriveZidContactCardKey(...) }` so a peer
 * who imports it can establish the pairwise secret and find you. `card` stays
 * optional so legacy exports still import.
 */
export function importFromWallet(contacts: ContactShare[]) {
  for (const c of contacts) {
    upsertContact(c.pubkey, c.name, c.card);
  }
}

/** count of contacts */
export function contactCount(): number {
  return loadContacts().length;
}
