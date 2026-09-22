/**
 * The ephemeral (no-wallet) identity - the guest.
 *
 * `zid.connect()` falls back to this when no zafu wallet answers. It is NOT a
 * weaker identity: from one in-page seed it derives the SAME surface a wallet
 * exposes - an ed25519 site identity and an X-Wing (X25519 + ML-KEM-768) sealed
 * box - so `keys()` / `sealFor()` / `openSealed()` behave the way `zidPubkey()` /
 * `encryptFor()` / `decryptFrom()` do, and the channel defaults to the hybrid
 * post-quantum Noise IK handshake. An app can therefore run with or without the
 * wallet installed against the same call sites.
 *
 * Derivation SHAPE mirrors the extension's `state/identity.ts` (root -> named
 * identity -> per-purpose domain-separated seed) and reuses its domain tags
 * verbatim (`site:`, `xwing-site\0<origin>\0N`, `contact-ka-v1`) so the signing
 * and KEM keys never share material - but nothing here imports the extension.
 * The seed is a random root, not a mnemonic: there is no wallet to hash.
 *
 * CUSTODY - read this. The guest identity is BURNER-GRADE. By default the seed
 * lives IN MEMORY for the page and is gone on reload; `{ persist: 'local' }`
 * stows it in `localStorage` so it survives reloads, which is still not a wallet:
 * there is no backup phrase, no recovery, no hardware binding, and any script on
 * the origin can read it. Treat it as a throwaway handle, not the user's keys.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import {
  XWING_LENGTHS,
  XWING_SUITE,
  openXWing,
  pqKeyAuthMessage,
  sealXWing,
  xwingKeypairFromSeed,
} from '@zafu/pq';
import { ZafuError } from './errors';
import { createChannel } from './channel';
import { openChannel } from './channel-select';
import { establishContactSecret, getContactRefs, resolveHandle } from './contacts';
import { createHttpRelayTransport } from './relay-http';
import {
  ContactRelay,
  PRESENCE_BLOB_BYTES,
  PRESENCE_PAD_TO,
  type RelayTransport,
} from './contact-relay';
import { createPresenceService, discoverContacts } from './presence-service';
import type { SessionKey as NoiseSessionKey } from './noise-channel';
import type {
  AdvertisedKeys,
  ChannelMode,
  ContactCardKey,
  DiscoverOptions,
  InvitePayload,
  PickContactsOptions,
  SealedBox,
  OpenableSealed,
  ZidIdentity,
} from './types';

const enc = new TextEncoder();

/** versioned so a future format change cannot be read as the old one. */
const GUEST_SEED_STORAGE_KEY = 'zid_guest_seed_v1';

/**
 * In-memory hold for the default (non-persisted) seed, keyed by app scope, so
 * repeated `connect()` calls in one page yield the SAME identity instead of a
 * new keypair per call - re-deriving an identity under a peer's nose would look
 * like key rotation. Cleared by a reload, which is the point.
 */
const inMemorySeeds = new Map<string, Uint8Array>();

export interface GuestOptions {
  /** app scope: the site identity's origin and the relay's bucket namespace. */
  origin: string;
  appName?: string;
  relayUrl?: string;
  /** which handshake `channel()` uses; the SAME option the wallet path takes. */
  channel?: ChannelMode;
  persist?: 'local';
  relayTransport?: RelayTransport;
  relayEndpoint?: string;
  /**
   * Bearer token for a relay that gates access - typically a friend's bouncer
   * (see apps/minibouncer). Presented on the hop TO the endpoint; a bouncer
   * replaces it with the relay's own token on the way out, so this is the
   * credential you were given, not the one the relay holds.
   */
  relayToken?: string;
  /** inject a seed - tests and deterministic identities only. */
  seed?: Uint8Array;
}

/**
 * Resolve the seed for this identity: caller-injected > `localStorage` (opt-in)
 * > the page's in-memory hold > a fresh random seed. `localStorage` access is
 * guarded: in SSR / a locked-down context the identity silently degrades to
 * burner (in-memory) rather than throwing.
 */
function resolveSeed(
  origin: string,
  persist: 'local' | undefined,
  injected?: Uint8Array,
): Uint8Array {
  if (injected) {
    return Uint8Array.from(injected);
  }
  if (persist === 'local') {
    try {
      const stored = localStorage.getItem(GUEST_SEED_STORAGE_KEY);
      if (stored) {
        return hexToBytes(stored);
      }
    } catch {
      /* no localStorage here - fall through to a burner seed */
    }
    const seed = randomBytes(32);
    try {
      localStorage.setItem(GUEST_SEED_STORAGE_KEY, bytesToHex(seed));
    } catch {
      /* non-persistable context: the seed still works for this page */
    }
    return seed;
  }
  const held = inMemorySeeds.get(origin);
  if (held) {
    return Uint8Array.from(held);
  }
  const seed = randomBytes(32);
  inMemorySeeds.set(origin, seed);
  return seed;
}

// ---------------------------------------------------------------------------
// classical sealed box (X25519 ephemeral-static + AES-256-GCM)
// ---------------------------------------------------------------------------
//
// Wire-compatible with the wallet's `zafu_encrypt` classical path (see
// apps/extension external-encryption.ts): ephemeral X25519 DH against the
// recipient's ed25519 key converted to Montgomery form, HKDF-SHA256 keyed by
// both public keys, then AES-256-GCM over `nonce(12) || ct || tag`. We replicate
// it here rather than inventing a format, so a guest box opens in a wallet and
// vice versa. The post-quantum path never reaches this code.

const sealInfo = (ephemeralPub: Uint8Array, recipientXPub: Uint8Array): Uint8Array =>
  enc.encode(`zafu-seal-v1:${bytesToHex(ephemeralPub)}:${bytesToHex(recipientXPub)}`);

async function aesGcmSeal(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      cryptoKey,
      plaintext as BufferSource,
    ),
  );
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, 12);
  return out;
}

async function aesGcmOpen(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 12 + 16) {
    throw new ZafuError('invalid_request', 'sealed box: ciphertext too short');
  }
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'decrypt',
  ]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.subarray(0, 12) as BufferSource },
      cryptoKey,
      data.subarray(12) as BufferSource,
    ),
  );
}

/**
 * Convert a peer's ed25519 pubkey to its X25519 form, refusing an unusable one.
 *
 * Both steps can reject and both become a typed refusal: `Point.fromHex` rejects
 * an off-curve / malformed encoding, and `toMontgomery` rejects the identity and
 * other degenerate points (their conversion inverts by zero). Note `fromHex`
 * alone ACCEPTS the identity and all-zero encodings, so the conversion is doing
 * real work here, not just the parse.
 */
function recipientX25519OrRefuse(ed25519PubHex: string): Uint8Array {
  const bytes = hexToBytes(ed25519PubHex);
  try {
    ed25519.Point.fromHex(bytes);
    return ed25519.utils.toMontgomery(bytes);
  } catch {
    throw new ZafuError('invalid_request', 'recipient is not a usable ed25519 public key');
  }
}

/**
 * X25519 DH that REFUSES a non-contributory result. A low-order peer key makes
 * the shared secret a value the attacker chose, which would turn the sealed box
 * into a key anyone can derive - an error, never a weak key.
 *
 * (noble 1.9.7 already throws for such a key inside `scalarMult`; the explicit
 * check keeps OUR invariant - long-term-static against long-term-static, so
 * contributory behaviour is the right default - rather than borrowing it from a
 * library version that may change.)
 */
function checkedDh(privateKey: Uint8Array, peerU: Uint8Array): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, peerU);
  } catch {
    throw new ZafuError('invalid_request', 'peer key is unusable for key agreement (low-order)');
  }
  if (shared.every(b => b === 0)) {
    shared.fill(0);
    throw new ZafuError(
      'invalid_request',
      'peer key is degenerate: refusing a non-contributory shared secret',
    );
  }
  return shared;
}

/** classical seal to an ed25519 pubkey (hex); returns the ciphertext + our ephemeral X25519 pubkey. */
async function sealClassical(
  recipientEd25519Hex: string,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; ephemeralPub: Uint8Array }> {
  const recipientX = recipientX25519OrRefuse(recipientEd25519Hex);
  const ephemeralPriv = randomBytes(32);
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  let shared: Uint8Array;
  try {
    shared = checkedDh(ephemeralPriv, recipientX);
  } finally {
    ephemeralPriv.fill(0); // zeroize even when the peer key was refused
  }
  const key = hkdf(sha256, shared, undefined, sealInfo(ephemeralPub, recipientX), 32);
  shared.fill(0);
  const ciphertext = await aesGcmSeal(key, plaintext);
  key.fill(0);
  return { ciphertext, ephemeralPub };
}

/** classical open with our ed25519 seed/pub against the sender's ephemeral X25519 pubkey. */
async function openClassical(
  edSeed: Uint8Array,
  edPub: Uint8Array,
  ephemeralPub: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const xPriv = ed25519.utils.toMontgomerySecret(edSeed);
  const xPub = ed25519.utils.toMontgomery(edPub);
  let shared: Uint8Array;
  try {
    shared = checkedDh(xPriv, ephemeralPub);
  } finally {
    xPriv.fill(0);
  }
  const key = hkdf(sha256, shared, undefined, sealInfo(ephemeralPub, xPub), 32);
  shared.fill(0);
  const plaintext = await aesGcmOpen(key, ciphertext);
  key.fill(0);
  return plaintext;
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * Build the guest identity. Every key is derived from one seed with the same
 * domain-separated shape the wallet uses, so nothing here is a placeholder.
 */
export function createGuestIdentity(opts: GuestOptions): ZidIdentity {
  const origin = opts.origin;
  const seed = resolveSeed(origin, opts.persist, opts.seed);

  const identity = hmac(sha512, seed, enc.encode('identity:guest'));
  // ed25519 signing key - the wallet's 'site:' tag, so the guest key is the same
  // KIND of artifact a wallet site key is.
  const edSeed = hmac(sha512, identity, enc.encode(`site:${origin}`)).slice(0, 32);
  const edPub = ed25519.getPublicKey(edSeed);
  const pubkey = bytesToHex(edPub);
  // X-Wing KEM seed - 'xwing-site\0<origin>\0<rotation>', rotation always encoded
  // (mirrors identity.ts) and NUL-delimited so an origin containing ':' cannot
  // collide with the rotation field. The guest never rotates: epoch stays 0.
  const xwing = xwingKeypairFromSeed(
    hmac(sha512, identity, enc.encode('xwing-site\0' + origin + '\0' + '0')).slice(
      0,
      XWING_LENGTHS.seed,
    ),
  );
  const pq_pubkey = bytesToHex(xwing.publicKey);
  // static X25519 key-agreement key for contact discovery ('contact-ka-v1').
  const kaPriv = hmac(sha512, identity, enc.encode('contact-ka-v1')).slice(0, 32);
  identity.fill(0);

  const card: ContactCardKey = {
    suite: 'x25519-v1',
    publicKey: bytesToHex(x25519.getPublicKey(kaPriv)),
  };

  // the hybrid Noise handshake needs the ed25519 seed as its X25519 static key.
  const session: NoiseSessionKey = {
    pubkey,
    privkey: edSeed,
    sign: async (data: Uint8Array): Promise<string> => bytesToHex(ed25519.sign(data, edSeed)),
  };

  /** self-signed key advertisement - pq_sig authenticates pq_pubkey with pubkey. */
  const advertisedKeys = (): AdvertisedKeys => ({
    pubkey,
    pq_pubkey,
    pq_suite: XWING_SUITE,
    pq_sig: bytesToHex(
      ed25519.sign(pqKeyAuthMessage(XWING_SUITE, origin, 0, xwing.publicKey), edSeed),
    ),
    pq_epoch: 0,
    origin,
  });

  const deriveRootSecret = (peer: ContactCardKey): Uint8Array => {
    if (peer.suite !== 'x25519-v1') {
      throw new ZafuError('invalid_request', `unsupported contact suite: ${peer.suite}`);
    }
    return x25519.getSharedSecret(kaPriv, hexToBytes(peer.publicKey));
  };

  const sealFor = async (
    recipient: AdvertisedKeys | string,
    bytes: Uint8Array,
  ): Promise<SealedBox> => {
    const r: AdvertisedKeys = typeof recipient === 'string' ? { pubkey: recipient } : recipient;
    if (r.pq_pubkey) {
      // Same invariant as encryptFor (P1): an advertised PQ prekey MUST be
      // authenticated by the recipient's ed25519 key, or it could have been
      // swapped in the distribution channel. Refuse rather than downgrade.
      const suite = r.pq_suite ?? XWING_SUITE;
      const epoch = r.pq_epoch ?? 0;
      const ok =
        !!r.pq_sig &&
        !!r.origin &&
        ed25519.verify(
          hexToBytes(r.pq_sig),
          pqKeyAuthMessage(suite, r.origin, epoch, hexToBytes(r.pq_pubkey)),
          hexToBytes(r.pubkey),
        );
      if (!ok) {
        throw new ZafuError(
          'invalid_request',
          'recipient pq_pubkey failed identity-key authentication (missing/invalid pq_sig or origin)',
        );
      }
      return {
        ciphertext: sealXWing(hexToBytes(r.pq_pubkey), bytes),
        ephemeral_pubkey: new Uint8Array(0),
        postQuantum: true,
        pq_epoch: epoch,
      };
    }
    const { ciphertext, ephemeralPub } = await sealClassical(r.pubkey, bytes);
    return { ciphertext, ephemeral_pubkey: ephemeralPub, postQuantum: false };
  };

  const openSealed = async (sealed: OpenableSealed): Promise<Uint8Array> =>
    sealed.ephemeral_pubkey.length === 0
      ? openXWing(xwing.secretKey, sealed.ciphertext)
      : openClassical(edSeed, edPub, sealed.ephemeral_pubkey, sealed.ciphertext);

  function readStoredName(): string | null {
    const appKey = opts.appName ? `zid_name:${opts.appName}` : 'zid_name';
    try {
      return localStorage.getItem(appKey) || localStorage.getItem('zid_name');
    } catch {
      return null;
    }
  }

  const name = readStoredName() ?? pubkey.slice(0, 8);

  return {
    pubkey,
    network: 'none',
    name,
    sign: async (data: Uint8Array) => bytesToHex(ed25519.sign(data, edSeed)),
    verify: async (data: Uint8Array, sig: string, pubkeyHex: string) => {
      try {
        return ed25519.verify(hexToBytes(sig), data, hexToBytes(pubkeyHex));
      } catch {
        return false;
      }
    },

    // the handshake is the caller's choice (opts.channel); 'hybrid' by default.
    channel: (peerPubkey: string) => openChannel(session, peerPubkey, opts.relayUrl, opts.channel),

    keys: advertisedKeys,
    sealFor,
    openSealed,
    contactCard: () => card,
    deriveRootSecret,
    establishSecret: (contactPubkey: string) =>
      establishContactSecret(contactPubkey, deriveRootSecret),

    discover: async (peers, discoverOpts?: DiscoverOptions) => {
      const transport =
        discoverOpts?.transport ??
        opts.relayTransport ??
        (opts.relayEndpoint
          ? createHttpRelayTransport({
              endpoint: opts.relayEndpoint,
              ...(opts.relayToken === undefined || opts.relayToken === ''
                ? {}
                : { headers: { authorization: `Bearer ${opts.relayToken}` } }),
            })
          : undefined);
      if (!transport) {
        throw new ZafuError(
          'unavailable',
          'discovery needs a relay transport: pass relayEndpoint or relayTransport to zid.connect()',
        );
      }
      const appOrigin = discoverOpts?.appOrigin ?? origin;
      const relay = new ContactRelay(transport, {
        appOrigin,
        padTo: PRESENCE_PAD_TO,
        blobBytes: PRESENCE_BLOB_BYTES,
      });
      const service = createPresenceService(relay, appOrigin, card.publicKey);
      return discoverContacts(service, peers, discoverOpts?.epoch);
    },

    pickContacts: async (_pickOpts?: PickContactsOptions) => getContactRefs(origin),

    invite: async (handle: string, payload: InvitePayload) => {
      const target = resolveHandle(handle, origin);
      if (!target) {
        return { sent: false };
      }
      // Invite delivery is the bootstrap exception: the handle resolves to a bare
      // pubkey with no advertised PQ key, and the receiving side is an app-level
      // listener rather than channel(), so it keeps the classical channel to stay
      // byte-compatible with existing invite senders. Use channel() for hybrid.
      const ch = await createChannel(session, target, opts.relayUrl);
      ch.send(JSON.stringify({ type: 'zid:invite', payload, from: name, appOrigin: origin }));
      // don't close the channel immediately - the recipient needs time to receive
      setTimeout(() => ch.close(), 30_000);
      return { sent: true };
    },

    mode: 'ephemeral',
    disconnect: () => {
      /* the seed is in memory (or opt-in localStorage); nothing to revoke here */
    },
  };
}
