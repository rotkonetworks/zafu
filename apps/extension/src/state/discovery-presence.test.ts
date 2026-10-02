/**
 * Discovery presence: when beacons go out, their fixed shape, and that two
 * wallets who swapped cards find each other (and nobody else) through one
 * blind relay - over an in-memory relay that merges by tag like minirelay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { PRESENCE_PAD_TO, presenceEpoch, type PresenceEntry, type RelayTransport } from '@zafu/zid';
import { createDiscoveryPresence, type PresenceHold } from './discovery-presence';
import { runDiscoveryForScope, type ContactDiscoveryDeps } from './contact-discovery-service';
import { computeContactHandle } from './contact-discovery';
import { deriveZidContactCardKey } from './identity';
import type { Contact } from './contacts';

vi.mock('.', () => ({ useStore: { getState: () => ({}) } }));

/** minirelay's contract: POST merges by tag, GET returns the whole bucket */
class MergingRelay implements RelayTransport {
  readonly puts: { appScope: string; epoch: number; count: number }[] = [];
  private readonly buckets = new Map<string, Map<string, PresenceEntry>>();
  async putBucket(req: {
    appScope: string;
    epoch: number;
    shard: string;
    entries: PresenceEntry[];
  }) {
    this.puts.push({ appScope: req.appScope, epoch: req.epoch, count: req.entries.length });
    const key = `${req.appScope}|${req.epoch}|${req.shard}`;
    const bucket = this.buckets.get(key) ?? new Map<string, PresenceEntry>();
    for (const e of req.entries) {
      bucket.set(bytesToHex(e.tag), e);
    }
    this.buckets.set(key, bucket);
  }
  async getBucket(req: { appScope: string; epoch: number; shard: string }) {
    return [...(this.buckets.get(`${req.appScope}|${req.epoch}|${req.shard}`)?.values() ?? [])];
  }
}

const APP = 'http://localhost:8123';
const OTHER_APP = 'http://127.0.0.1:8123';
const A_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const B_PHRASE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const kaOf = (phrase: string) => deriveZidContactCardKey(phrase, 'default');

const contactWith = (id: string, phrase: string): Contact => ({
  id,
  name: id,
  createdAt: 0,
  addresses: [],
  card: kaOf(phrase),
});

interface Wallet {
  deps: ContactDiscoveryDeps;
  grants: Set<string>;
  state: { enabled: boolean; locked: boolean; contacts: Contact[] };
}

const wallet = (relay: RelayTransport, phrase: string, contacts: Contact[] = []): Wallet => {
  const grants = new Set<string>();
  const state = { enabled: true, locked: false, contacts };
  return {
    grants,
    state,
    deps: {
      settings: async () => ({
        enabled: state.enabled,
        relayEndpoint: 'http://127.0.0.1:8099',
        relayToken: '',
      }),
      locked: async () => state.locked,
      siteAllowed: async origin => grants.has(origin),
      contacts: async () => state.contacts,
      identity: async () => ({ mnemonic: phrase, identityName: 'default' }),
      transport: () => relay,
    },
  };
};

const hold = (): PresenceHold & { closed: boolean } => {
  const h = {
    closed: false,
    close: () => {
      h.closed = true;
    },
  };
  return h;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:10Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cadence', () => {
  it('writes exactly 64 entries per window for a granted open site, even with zero friends', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE);
    a.grants.add(APP);
    const presence = createDiscoveryPresence(a.deps);

    expect(await presence.hold(APP, hold())).toBe(true);
    expect(relay.puts).toEqual([{ appScope: APP, epoch: presenceEpoch(), count: PRESENCE_PAD_TO }]);
    expect(PRESENCE_PAD_TO).toBe(64);

    // heartbeats inside the window write nothing more
    await presence.tick();
    await presence.tick();
    expect(relay.puts).toHaveLength(1);

    // the next window: one more write, same size
    vi.setSystemTime(Date.now() + 300_000);
    await presence.tick();
    expect(relay.puts).toHaveLength(2);
    expect(relay.puts[1]).toMatchObject({ epoch: presenceEpoch(), count: 64 });
  });

  it('writes 64 entries with friends too, so the count says nothing', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE, [contactWith('bob', B_PHRASE)]);
    a.grants.add(APP);
    await createDiscoveryPresence(a.deps).hold(APP, hold());
    expect(relay.puts.map(p => p.count)).toEqual([64]);
  });
});

describe('no publish', () => {
  it('without the site grant: the hold is refused and closed, nothing is written', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE);
    const presence = createDiscoveryPresence(a.deps);
    const h = hold();

    expect(await presence.hold(APP, h)).toBe(false);
    expect(h.closed).toBe(true);
    await presence.publishNow(APP);
    await presence.tick();
    expect(relay.puts).toHaveLength(0);
  });

  it('while discovery is off, even for a site that holds the grant', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE);
    a.grants.add(APP);
    a.state.enabled = false;
    const presence = createDiscoveryPresence(a.deps);
    await presence.hold(APP, hold());
    await presence.publishNow(APP);
    expect(relay.puts).toHaveLength(0);
  });

  it('while locked', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE);
    a.grants.add(APP);
    a.state.locked = true;
    await createDiscoveryPresence(a.deps).hold(APP, hold());
    expect(relay.puts).toHaveLength(0);
  });

  it('while everything is closed: no page holds, so no window ever writes', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE);
    a.grants.add(APP); // granted, but nothing open
    const presence = createDiscoveryPresence(a.deps);
    for (let i = 0; i < 3; i++) {
      await presence.tick();
      vi.setSystemTime(Date.now() + 300_000);
    }
    expect(relay.puts).toHaveLength(0);
  });

  it('after the last page of the site closes', async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE);
    a.grants.add(APP);
    const presence = createDiscoveryPresence(a.deps);
    const one = hold();
    const two = hold();
    await presence.hold(APP, one);
    await presence.hold(APP, two);
    presence.release(APP, one);
    vi.setSystemTime(Date.now() + 300_000);
    await presence.tick();
    expect(relay.puts).toHaveLength(2); // the second tab still holds
    presence.release(APP, two);
    expect(presence.live()).toEqual([]);
    vi.setSystemTime(Date.now() + 300_000);
    await presence.tick();
    expect(relay.puts).toHaveLength(2);
  });
});

describe('matching', () => {
  const setup = async () => {
    const relay = new MergingRelay();
    const a = wallet(relay, A_PHRASE, [contactWith('bob', B_PHRASE)]);
    const b = wallet(relay, B_PHRASE, [contactWith('alice', A_PHRASE)]);
    a.grants.add(APP);
    b.grants.add(APP);
    const pa = createDiscoveryPresence(a.deps);
    const pb = createDiscoveryPresence(b.deps);
    await pa.hold(APP, hold());
    await pb.hold(APP, hold());
    // a stranger on the same site: 64 entries of someone neither of them knows
    const stranger = wallet(
      relay,
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    );
    stranger.grants.add(APP);
    await createDiscoveryPresence(stranger.deps).hold(APP, hold());
    return { relay, a, b, pa, pb };
  };

  it('each finds the other, under a per-site handle, and nobody else', async () => {
    const { relay, a, b } = await setup();
    expect(
      (await relay.getBucket({ appScope: APP, epoch: presenceEpoch(), shard: '' })).length,
    ).toBe(192);

    const seenByA = await runDiscoveryForScope(APP, a.deps);
    const seenByB = await runDiscoveryForScope(APP, b.deps);
    expect(seenByA).toEqual({
      contacts: [
        {
          handle: await computeContactHandle(kaOf(B_PHRASE).publicKey, APP),
          sessionPubHex: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string,
          caps: 0,
        },
      ],
    });
    expect('contacts' in seenByB && seenByB.contacts).toHaveLength(1);

    // the same friend on another site is another handle
    const there = await computeContactHandle(kaOf(B_PHRASE).publicKey, OTHER_APP);
    expect('contacts' in seenByA && seenByA.contacts[0]!.handle).not.toBe(there);
  });

  it('is mutual: when B takes the grant back, neither sees the other, at once', async () => {
    const { a, b, pb } = await setup();
    b.grants.delete(APP);
    await pb.recheck(); // what the worker does when the switch flips

    expect(await runDiscoveryForScope(APP, a.deps)).toEqual({ contacts: [] });
    expect(await runDiscoveryForScope(APP, b.deps)).toMatchObject({ code: 'not_available' });
    expect(pb.live()).toEqual([]);
  });

  it('a site you did not grant finds nobody, even with friends beaconing there', async () => {
    const { a } = await setup();
    a.grants.delete(APP);
    expect(await runDiscoveryForScope(APP, a.deps)).toMatchObject({ code: 'not_available' });
  });

  it('an address-only contact (no card key) is never looked for', async () => {
    const relay = new MergingRelay();
    const b = wallet(relay, B_PHRASE, [contactWith('alice', A_PHRASE)]);
    b.grants.add(APP);
    await createDiscoveryPresence(b.deps).hold(APP, hold());
    const a = wallet(relay, A_PHRASE, [{ id: 'bob', name: 'bob', createdAt: 0, addresses: [] }]);
    a.grants.add(APP);
    expect(await runDiscoveryForScope(APP, a.deps)).toEqual({ contacts: [] });
  });
});
