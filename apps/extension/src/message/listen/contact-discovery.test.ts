/**
 * Handler contract tests for `zafu_discover_contacts`.
 *
 * The wallet-side discovery core is exercised end-to-end over an in-memory
 * relay (the same fake the @zafu/zid suites use): a peer really publishes a
 * sealed presence blob and the handler really opens it. This proves the
 * app-facing invariants - absent contacts are never returned, legacy contacts
 * (no card) are skipped, the refusal codes, and that no raw contact pubkey
 * crosses the boundary - with a fake RelayTransport standing in for the
 * user-configured relay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import {
  ContactRelay,
  PRESENCE_BLOB_BYTES,
  PRESENCE_PAD_TO,
  createPresenceService,
  presenceEpoch,
  type PresenceEntry,
  type RelayTransport,
} from '@zafu/zid';
import type { ZafuDiscoverContactsResponse } from '@zafu/protocol';
import { createContactDiscoveryListener } from './contact-discovery';
import type { ContactDiscoveryDeps } from '../../state/contact-discovery-service';
import type { Contact } from '../../state/contacts';
import { deriveRelationshipKeys, discoverySecret } from '../../state/identity';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

// in-memory blind relay: a dumb KV store keyed by (appScope, epoch, shard).
class MemRelay implements RelayTransport {
  store = new Map<string, PresenceEntry[]>();
  private key(a: string, e: number, s: string) {
    return `${a}|${e}|${s}`;
  }
  async putBucket(req: {
    appScope: string;
    epoch: number;
    shard: string;
    entries: PresenceEntry[];
  }) {
    this.store.set(this.key(req.appScope, req.epoch, req.shard), req.entries);
  }
  async getBucket(req: { appScope: string; epoch: number; shard: string }) {
    return this.store.get(this.key(req.appScope, req.epoch, req.shard)) ?? [];
  }
}

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PEER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const ABSENT = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const WALLET = 'wallet-1';
const APP = 'https://poker.zk.bot';

// the relationship I gave the peer (j 0) and the one the peer gave me (j 4)
const mine = deriveRelationshipKeys(MNEMONIC, 0, 0);
const peerRel = deriveRelationshipKeys(PEER, 0, 4);
const peerPub = peerRel.kaPublicKey;
const rootSecret = discoverySecret(peerRel.kaSeed, mine.kaPublicKey, peerRel.xid, mine.xid);

// a second, always-absent peer, holding my relationship 1
const absentRel = deriveRelationshipKeys(ABSENT, 0, 0);
const absentPub = absentRel.kaPublicKey;

const SESSION_PUB = new Uint8Array(32).fill(0xa5);

const contacts: Contact[] = [
  {
    id: 'present',
    name: 'Present',
    createdAt: 0,
    addresses: [],
    rel: { walletId: WALLET, gen: 0, j: 0 },
    pairKa: peerPub,
    zid: peerRel.pubkey,
  },
  {
    id: 'absent',
    name: 'Absent',
    createdAt: 0,
    addresses: [],
    rel: { walletId: WALLET, gen: 0, j: 1 },
    pairKa: absentPub,
    zid: absentRel.pubkey,
  },
  // saved from an older card: one identity-wide key, no relationship
  {
    id: 'legacy',
    name: 'Legacy',
    createdAt: 0,
    addresses: [],
    card: { suite: 'x25519-v1', publicKey: 'ab'.repeat(32) },
  },
];

/** have the present peer beacon its presence into `relay` at `epoch`. */
const publishPeerPresence = async (relay: MemRelay, epoch: number): Promise<void> => {
  const service = createPresenceService(
    new ContactRelay(relay, {
      appOrigin: APP,
      padTo: PRESENCE_PAD_TO,
      blobBytes: PRESENCE_BLOB_BYTES,
    }),
    APP,
  );
  await service.publishSelf(
    { sessionPub: SESSION_PUB, caps: 5 },
    [{ id: 'peer', friendPubHex: mine.kaPublicKey, myPubHex: peerPub, rootSecret }],
    epoch,
  );
};

const depsWith = (
  relay: MemRelay,
  overrides: Partial<ContactDiscoveryDeps> = {},
): ContactDiscoveryDeps => ({
  settings: async () => ({ enabled: true, relayEndpoint: 'https://relay.example', relayToken: '' }),
  locked: async () => false,
  siteAllowed: async () => true,
  contacts: async () => contacts,
  identity: async () => ({ mnemonic: MNEMONIC, walletId: WALLET }),
  transport: () => relay,
  ...overrides,
});

const senderFor = (origin: string): chrome.runtime.MessageSender =>
  ({
    tab: { id: 1 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'doc-1',
    documentLifecycle: 'active',
    origin,
    url: `${origin}/index.html`,
  }) as chrome.runtime.MessageSender;

const call = (
  deps: ContactDiscoveryDeps,
  req: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<ZafuDiscoverContactsResponse> => {
  const { promise, resolve } = Promise.withResolvers<ZafuDiscoverContactsResponse>();
  createContactDiscoveryListener(deps)(req, sender, resolve);
  return promise;
};

/**
 * independently recompute the app-scoped handle the response must carry:
 * HKDF of the pair's own secret, never a hash of a public card key.
 */
const expectedHandle = (secret: Uint8Array, appScope: string): string =>
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

let relay: MemRelay;
let epoch: number;

beforeEach(() => {
  // freeze the clock so the presence epoch is deterministic for publish + read.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  relay = new MemRelay();
  epoch = presenceEpoch();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('zafu_discover_contacts - present intersection only', () => {
  it('returns the present contact and never an absent or legacy one', async () => {
    await publishPeerPresence(relay, epoch);

    const res = await call(
      depsWith(relay),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );

    expect('contacts' in res).toBe(true);
    if (!('contacts' in res)) {
      return;
    }
    expect(res.contacts).toHaveLength(1);
    const [found] = res.contacts;
    expect(found!.handle).toBe(expectedHandle(rootSecret, APP));
    // not the old public formula a card holder could compute
    const old = bytesToHex(sha256(new TextEncoder().encode(`${peerPub}:${APP}:zid:contact:v1`)));
    expect(found!.handle).not.toBe(old);
    expect(found!.sessionPubHex).toBe(bytesToHex(SESSION_PUB));
    expect(found!.caps).toBe(5);
  });

  it('answers an empty intersection - never the contact list - when nobody is present', async () => {
    const res = await call(
      depsWith(relay),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res).toEqual({ contacts: [] });
  });

  it("hands a gated relay's token to the transport, so a friend's bouncer just works", async () => {
    await publishPeerPresence(relay, epoch);
    const built: Array<{ endpoint: string; token: string }> = [];
    const res = await call(
      depsWith(relay, {
        settings: async () => ({
          enabled: true,
          relayEndpoint: 'https://bouncer.example',
          relayToken: 'friend-token',
        }),
        transport: (endpoint, token) => {
          built.push({ endpoint, token });
          return relay;
        },
      }),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res.contacts).toHaveLength(1);
    expect(built).toEqual([{ endpoint: 'https://bouncer.example', token: 'friend-token' }]);
  });

  it('never puts a raw contact pubkey (or the root secret) in the response', async () => {
    await publishPeerPresence(relay, epoch);
    const res = await call(
      depsWith(relay),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    const wire = JSON.stringify(res);
    expect(wire).not.toContain(peerPub); // the peer's contact-card key
    expect(wire).not.toContain(absentPub);
    expect(wire).not.toContain(bytesToHex(rootSecret)); // the pairwise secret
    // the only key-shaped value is the peer's EPHEMERAL session pubkey.
    expect(wire).toContain(bytesToHex(SESSION_PUB));
  });
});

describe('zafu_discover_contacts - refusals', () => {
  it('refuses not_available when the feature is off', async () => {
    const res = await call(
      depsWith(relay, {
        settings: async () => ({
          enabled: false,
          relayEndpoint: 'https://r.example',
          relayToken: '',
        }),
      }),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res).toEqual({ error: 'contact discovery is not available', code: 'not_available' });
  });

  it('refuses not_available when no relay endpoint is configured', async () => {
    const res = await call(
      depsWith(relay, {
        settings: async () => ({ enabled: true, relayEndpoint: '', relayToken: '' }),
      }),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res).toEqual({ error: 'contact discovery is not available', code: 'not_available' });
  });

  it('refuses not_available when the configured endpoint is not a usable URL', async () => {
    const res = await call(
      depsWith(relay, {
        settings: async () => ({ enabled: true, relayEndpoint: 'not a url', relayToken: '' }),
      }),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res).toEqual({ error: 'contact discovery is not available', code: 'not_available' });
  });

  it('refuses not_available, and reads no relay, when this site has no "find friends" grant', async () => {
    const transport = vi.fn(() => relay);
    const res = await call(
      depsWith(relay, { siteAllowed: async origin => origin !== APP, transport }),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res).toEqual({ error: 'contact discovery is not available', code: 'not_available' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses not_available when the wallet is locked', async () => {
    const res = await call(
      depsWith(relay, { locked: async () => true }),
      { type: 'zafu_discover_contacts', appScope: APP },
      senderFor(APP),
    );
    expect(res).toEqual({ error: 'contact discovery is not available', code: 'not_available' });
  });

  it('rejects a request that names a scope other than the caller origin', async () => {
    const res = await call(
      depsWith(relay),
      { type: 'zafu_discover_contacts', appScope: 'https://victim.example' },
      senderFor(APP),
    );
    expect(res).toEqual({
      error: 'appScope does not match the calling origin',
      code: 'invalid_request',
    });
  });

  it('rejects a non-https / sub-frame sender', async () => {
    const res = await call(depsWith(relay), { type: 'zafu_discover_contacts', appScope: APP }, {
      frameId: 3,
      origin: APP,
    } as chrome.runtime.MessageSender);
    expect(res).toEqual({ error: 'denied', code: 'denied' });
  });

  it('rate limits a single origin', async () => {
    const origin = 'https://busy.example';
    const listener = createContactDiscoveryListener(depsWith(relay));
    let last: ZafuDiscoverContactsResponse | undefined;
    for (let i = 0; i < 21; i++) {
      const { promise, resolve } = Promise.withResolvers<ZafuDiscoverContactsResponse>();
      listener({ type: 'zafu_discover_contacts', appScope: origin }, senderFor(origin), resolve);
      last = await promise;
    }
    expect(last).toEqual({ error: 'rate limited', code: 'rate_limited' });
  });
});
