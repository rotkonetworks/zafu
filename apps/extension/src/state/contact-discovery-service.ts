/**
 * Wallet-side contact-discovery SERVICE - the production wiring that joins the
 * extension's storage/unlock state to the discovery core (./contact-discovery).
 *
 * Split from the core so the core stays pure (contacts + mnemonic + transport
 * in, presence out) and the message listener can be driven with fakes in tests.
 * This module owns the pieces that need chrome/storage: the settings read, the
 * lock check, the encrypted contacts read, the mnemonic/identity lookup, and the
 * relay transport, plus the fixed-cadence presence publisher the service
 * worker's alarm drives.
 *
 * Everything here is a STRICT NO-OP unless the user opted in AND configured a
 * relay AND the wallet is unlocked. A wallet that never opted in never reads a
 * contact, never derives a secret, and never opens a socket.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { getAllPermissions } from '@repo/storage-chrome/origin';
import type { ZafuDiscoverContactsResponse } from '@zafu/protocol';
import {
  createHttpRelayTransport,
  createPresenceScheduler,
  createPresenceService,
  presenceEpoch,
  type PresenceScheduler,
  type PublishArgs,
  type RelayTransport,
} from '@zafu/zid';
import { useStore } from '.';
import { readEncryptedWithMigration } from './encrypted-storage';
import { currentIdentityName, deriveZidContactCardKey } from './identity';
import type { Contact } from './contacts';
import { buildPublishArgs, createContactRelay, discoverForScope } from './contact-discovery';

/** true when `endpoint` is an http(s) URL the relay transport can talk to.
 *  Anything else (unset, garbage) leaves the feature unconfigured. */
const isUsableRelayEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

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
  /** the wallet's contacts (decrypted). */
  contacts: () => Promise<Contact[]>;
  /** mnemonic + active identity name, or null when no key is selected. */
  identity: () => Promise<{ mnemonic: string; identityName: string } | null>;
  /** build a relay transport for a configured endpoint, token and all. */
  transport: (endpoint: string, token: string) => RelayTransport;
}

/** the real deps, backed by extension storage + the keyring. */
export const contactDiscoveryDeps: ContactDiscoveryDeps = {
  settings: async () => {
    const stored = await localExtStorage.get('zidDiscovery');
    return {
      enabled: stored?.enabled === true,
      relayEndpoint: (stored?.relayEndpoint ?? '').trim(),
      relayToken: (stored?.relayToken ?? '').trim(),
    };
  },
  locked: async () => !(await sessionExtStorage.get('passwordKey')),
  contacts: async () =>
    (await readEncryptedWithMigration<Contact[]>(localExtStorage, sessionExtStorage, 'contacts')) ??
    [],
  identity: async () => {
    const keyInfo = useStore.getState().keyRing.selectedKeyInfo;
    if (!keyInfo) {
      return null;
    }
    const mnemonic = await useStore.getState().keyRing.getMnemonic(keyInfo.id);
    return { mnemonic, identityName: await currentIdentityName() };
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
): Promise<ZafuDiscoverContactsResponse> => {
  try {
    const { enabled, relayEndpoint, relayToken } = await deps.settings();
    if (!enabled || !isUsableRelayEndpoint(relayEndpoint)) {
      return NOT_AVAILABLE;
    }
    if (await deps.locked()) {
      return NOT_AVAILABLE;
    }
    const identity = await deps.identity();
    if (!identity) {
      return NOT_AVAILABLE;
    }
    const contacts = await deps.contacts();
    const discovered = await discoverForScope({
      appScope,
      contacts,
      mnemonic: identity.mnemonic,
      identityName: identity.identityName,
      transport: deps.transport(relayEndpoint, relayToken),
    });
    return { contacts: discovered };
  } catch (e) {
    // never surface internal detail (and never a secret) to the caller.
    console.warn('[contact-discovery] discovery failed:', e);
    return { error: 'contact discovery failed', code: 'internal_error' };
  }
};

/**
 * App scopes this wallet beacons in: origins the user has approved (any granted
 * capability). Presence is app-scoped, so there is nothing to publish for an
 * origin the wallet never connected to - and a site the user never approved
 * must never be able to find this wallet.
 */
const presenceScopes = async (): Promise<string[]> => {
  const permissions = await getAllPermissions();
  return permissions.filter(p => p.granted.length > 0).map(p => p.origin);
};

interface ScopeState {
  endpoint: string;
  /** the token the state was built with, so a changed token rebuilds the service. */
  token: string;
  identityName: string;
  scheduler: PresenceScheduler;
  /** the args the scheduler publishes on its next due tick. */
  box: { args: PublishArgs };
}

const scopeStates = new Map<string, ScopeState>();

/**
 * Publish this wallet's presence once per epoch, for every app scope it serves.
 * Driven by the `zidPresencePublish` alarm; idempotent within an epoch (the
 * per-scope `createPresenceScheduler` claims the epoch before publishing), so
 * over-ticking is harmless. A strict no-op when disabled, unconfigured, or
 * locked. Never throws.
 */
export const runPresencePublish = async (
  deps: ContactDiscoveryDeps = contactDiscoveryDeps,
): Promise<void> => {
  try {
    const { enabled, relayEndpoint, relayToken } = await deps.settings();
    if (!enabled || !isUsableRelayEndpoint(relayEndpoint)) {
      return;
    }
    if (await deps.locked()) {
      return;
    }
    const scopes = await presenceScopes();
    if (scopes.length === 0) {
      return;
    }
    const identity = await deps.identity();
    if (!identity) {
      return;
    }
    const epoch = presenceEpoch();
    const transport = deps.transport(relayEndpoint, relayToken);
    const myPubHex = deriveZidContactCardKey(identity.mnemonic, identity.identityName).publicKey;
    const contacts = await deps.contacts();

    for (const appScope of scopes) {
      let state = scopeStates.get(appScope);
      if (
        !state ||
        state.endpoint !== relayEndpoint ||
        state.token !== relayToken ||
        state.identityName !== identity.identityName
      ) {
        // settings/identity changed (or first run): rebuild so the service uses
        // the current relay + contact-card key.
        const box: { args: PublishArgs } = { args: null };
        state = {
          endpoint: relayEndpoint,
          token: relayToken,
          identityName: identity.identityName,
          scheduler: createPresenceScheduler(
            createPresenceService(createContactRelay(transport, appScope), appScope, myPubHex),
            () => box.args,
          ),
          box,
        };
        scopeStates.set(appScope, state);
      }
      if (state.scheduler.lastPublishedEpoch === epoch) {
        continue; // already beaconed this epoch
      }
      state.box.args = await buildPublishArgs({
        appScope,
        contacts,
        mnemonic: identity.mnemonic,
        identityName: identity.identityName,
        epoch,
      });
      await state.scheduler.tick();
    }
  } catch (e) {
    console.warn('[contact-presence] publish failed:', e);
  }
};
