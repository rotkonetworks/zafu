/**
 * Wallet-side contact-discovery SERVICE - the production wiring that joins the
 * extension's storage/unlock state to the discovery core (./contact-discovery).
 *
 * Split from the core so the core stays pure (contacts + mnemonic + transport
 * in, presence out) and the message listener can be driven with fakes in tests.
 * This module owns the pieces that need chrome/storage: the settings read, the
 * lock check, the encrypted contacts read, the mnemonic/identity lookup, and the
 * relay transport. Publishing presence is ./discovery-presence: only for a
 * granted site whose page is open. Opening a window, unlocking or a
 * service-worker start never publishes (no autoconnect).
 *
 * Everything here is a STRICT NO-OP unless the user opted in AND the wallet is
 * unlocked. A wallet that never opted in never reads a contact, never derives a
 * secret, and never opens a socket. An opted-in wallet with no endpoint of its
 * own talks to DEFAULT_CONTACT_DISCOVERY_RELAY - opting in IS the consent, so a
 * blank endpoint field cannot leave the feature dead.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import type { ZafuDiscoverContactsResponse } from '@zafu/protocol';
import { createHttpRelayTransport, type RelayTransport } from '@zafu/zid';
import { useStore } from '.';
import { readEncryptedWithMigration } from './encrypted-storage';
import type { Contact } from './contacts';
import { discoverForScope } from './contact-discovery';
import {
  DEFAULT_CONTACT_DISCOVERY_RELAY,
  isUsableRelayEndpoint,
} from '../config/contact-discovery-relay';
import { siteFindsFriends } from './find-friends';

/** the outward refusal. ONE message and code for every "can't serve this"
 *  reason (off, unconfigured, locked, no identity) so an arbitrary origin
 *  cannot fingerprint the wallet's lock/opt-in state. */
const NOT_AVAILABLE: ZafuDiscoverContactsResponse = {
  error: 'contact discovery is not available',
  code: 'not_available',
};

export interface ContactDiscoveryDeps {
  /**
   * current discovery settings: the opt-in flag, the relay endpoint, and the
   * bearer token if the endpoint is gated (a friend's or community's bouncer).
   */
  settings: () => Promise<{ enabled: boolean; relayEndpoint: string; relayToken: string }>;
  /** true when the wallet is locked (no session key). */
  locked: () => Promise<boolean>;
  /** this site holds the per-site "friends can find you here" grant */
  siteAllowed: (origin: string) => Promise<boolean>;
  /** the wallet's contacts (decrypted). */
  contacts: () => Promise<Contact[]>;
  /** mnemonic + the selected wallet's id, or null when no key is selected. */
  identity: () => Promise<{ mnemonic: string; walletId: string } | null>;
  /** build a relay transport for a configured endpoint, token and all. */
  transport: (endpoint: string, token: string) => RelayTransport;
}

/** the real deps, backed by extension storage + the keyring. */
export const contactDiscoveryDeps: ContactDiscoveryDeps = {
  settings: async () => {
    const stored = await localExtStorage.get('zidDiscovery');
    return {
      enabled: stored?.enabled === true,
      // An opted-in wallet with no endpoint of its own uses the built-in
      // relay: opting in is the consent, and a blank field must not leave the
      // feature dead. Explicit endpoints still win.
      relayEndpoint: (stored?.relayEndpoint ?? '').trim() || DEFAULT_CONTACT_DISCOVERY_RELAY,
      relayToken: (stored?.relayToken ?? '').trim(),
    };
  },
  locked: async () => !(await sessionExtStorage.get('passwordKey')),
  siteAllowed: siteFindsFriends,
  contacts: async () =>
    (await readEncryptedWithMigration<Contact[]>(localExtStorage, sessionExtStorage, 'contacts')) ??
    [],
  identity: async () => {
    const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
    if (!keyInfo) {
      return null;
    }
    const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);
    return { mnemonic, walletId: keyInfo.id };
  },
  transport: (endpoint, token) =>
    createHttpRelayTransport({
      endpoint,
      ...(token === '' ? {} : { headers: { authorization: `Bearer ${token}` } }),
    }),
};

/**
 * Serve one `zafu_discover_contacts` request: resolve the caller's scope, refuse
 * uniformly when the feature is unavailable, otherwise return the present
 * intersection for that scope. Never throws.
 */
export const runDiscoveryForScope = async (
  appScope: string,
  deps: ContactDiscoveryDeps = contactDiscoveryDeps,
  /** beacons this site first, so whoever you find can find you too (mutual) */
  publishNow?: (appScope: string) => Promise<void>,
): Promise<ZafuDiscoverContactsResponse> => {
  try {
    const { enabled, relayEndpoint, relayToken } = await deps.settings();
    if (!enabled || !isUsableRelayEndpoint(relayEndpoint)) {
      return NOT_AVAILABLE;
    }
    if (!(await deps.siteAllowed(appScope))) {
      return NOT_AVAILABLE;
    }
    if (await deps.locked()) {
      return NOT_AVAILABLE;
    }
    const identity = await deps.identity();
    if (!identity) {
      return NOT_AVAILABLE;
    }
    await publishNow?.(appScope);
    const contacts = await deps.contacts();
    const discovered = await discoverForScope({
      appScope,
      contacts,
      mnemonic: identity.mnemonic,
      walletId: identity.walletId,
      transport: deps.transport(relayEndpoint, relayToken),
    });
    return { contacts: discovered };
  } catch (e) {
    // never surface internal detail (and never a secret) to the caller.
    console.warn('[contact-discovery] discovery failed:', e);
    return { error: 'contact discovery failed', code: 'internal_error' };
  }
};
