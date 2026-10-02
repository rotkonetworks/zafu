/**
 * When this wallet beacons presence for private contact discovery, and for
 * which sites (DiscoveryHow.dc.html, step 3; design-social 2.10).
 *
 * A beacon in an app scope says "you are on this app". So it runs for a site
 * only while that site's own page is open and holds the person's "friends can
 * find you here" grant - never because a zafu window is open (that would claim
 * you are on zitadel.chat while you are reading your balance), and never on
 * install, unlock, service-worker start or an alarm. A page holds presence
 * through a port its content script opens once the site has asked zafu for
 * friends (or the person turned the grant on while it was open); the port
 * closes with the tab, and the beacon with it.
 *
 * While held, the cadence is fixed: one write per 5-minute window per app,
 * exactly PRESENCE_PAD_TO (64) entries, real tags padded with filler, even
 * with zero friends - so the relay cannot tell how many friends you have or
 * when you went quiet. Taking the grant away withdraws this window's beacon
 * at once (see `withdrawSelf`), which is what makes the switch mutual: you
 * stop seeing them, and they stop seeing you, now.
 *
 * Pure apart from the injected deps (storage, keyring and relay live in
 * contact-discovery-service), so the cadence and every gate are unit-tested.
 */

import {
  createPresenceScheduler,
  createPresenceService,
  presenceEpoch,
  type DiscoveryPeer,
  type PresenceScheduler,
  type PresenceService,
  type PublishArgs,
} from '@zafu/zid';
import { deriveZidContactCardKey } from './identity';
import {
  buildDiscoveryPeers,
  buildPresenceRecord,
  createContactRelay,
  deriveContactRootSecrets,
} from './contact-discovery';
import { isUsableRelayEndpoint } from '../config/contact-discovery-relay';
import type { ContactDiscoveryDeps } from './contact-discovery-service';

/** something keeping a site's presence alive: a content-script port. */
export interface PresenceHold {
  close(): void;
}

export interface DiscoveryPresence {
  /**
   * An open page of `origin` holds presence. Refused (and closed) unless the
   * site is granted; otherwise beacons now if this window has none yet.
   * Resolves whether the hold was kept.
   */
  hold(origin: string, h: PresenceHold): Promise<boolean>;
  /** the hold went away (tab closed, navigated, port dropped) */
  release(origin: string, h: PresenceHold): void;
  /** heartbeat from a held page: beacon every held site once per window */
  tick(): Promise<void>;
  /** beacon this site now if this window has none yet (the lookup path) */
  publishNow(origin: string): Promise<void>;
  /** grants or the global switch changed: withdraw and drop sites no longer granted */
  recheck(): Promise<void>;
  /** sites holding presence right now */
  live(): string[];
}

interface ScopeState {
  key: string;
  service: PresenceService;
  scheduler: PresenceScheduler;
  box: { args: PublishArgs };
}

interface Ready {
  endpoint: string;
  token: string;
  mnemonic: string;
  identityName: string;
}

export const createDiscoveryPresence = (
  deps: ContactDiscoveryDeps,
  opts: { nowSeconds?: () => number } = {},
): DiscoveryPresence => {
  const nowSeconds = opts.nowSeconds ?? (() => Date.now() / 1000);
  const holds = new Map<string, Set<PresenceHold>>();
  const scopes = new Map<string, ScopeState>();

  /** the site may beacon at all: discovery on, a usable relay, and the site's grant */
  const granted = async (origin: string): Promise<boolean> => {
    const { enabled, relayEndpoint } = await deps.settings();
    return enabled && isUsableRelayEndpoint(relayEndpoint) && (await deps.siteAllowed(origin));
  };

  /** everything a write needs, or undefined (locked, no key) */
  const ready = async (): Promise<Ready | undefined> => {
    const { relayEndpoint, relayToken } = await deps.settings();
    if (await deps.locked()) {
      return undefined;
    }
    const identity = await deps.identity();
    return identity ? { endpoint: relayEndpoint, token: relayToken, ...identity } : undefined;
  };

  const scopeFor = (origin: string, r: Ready): ScopeState => {
    const key = `${r.endpoint}|${r.token}|${r.identityName}`;
    const existing = scopes.get(origin);
    if (existing?.key === key) {
      return existing;
    }
    // first use, or the relay or identity changed: build against the current ones
    const myPubHex = deriveZidContactCardKey(r.mnemonic, r.identityName).publicKey;
    const service = createPresenceService(
      createContactRelay(deps.transport(r.endpoint, r.token), origin),
      origin,
      myPubHex,
    );
    const box: { args: PublishArgs } = { args: null };
    const state: ScopeState = {
      key,
      service,
      scheduler: createPresenceScheduler(service, () => box.args, { nowSeconds }),
      box,
    };
    scopes.set(origin, state);
    return state;
  };

  const peersFor = async (origin: string, r: Ready): Promise<DiscoveryPeer[]> => {
    const contacts = await deps.contacts();
    const secrets = deriveContactRootSecrets(contacts, r.mnemonic, r.identityName);
    return buildDiscoveryPeers(contacts, origin, secrets);
  };

  /** one beacon for `origin` this window, if it has none yet. Never throws. */
  const beacon = async (origin: string): Promise<void> => {
    try {
      if (!(await granted(origin))) {
        return;
      }
      const r = await ready();
      if (!r) {
        return;
      }
      const state = scopeFor(origin, r);
      const epoch = presenceEpoch(nowSeconds());
      if (state.scheduler.lastPublishedEpoch === epoch) {
        return;
      }
      state.box.args = {
        record: buildPresenceRecord(origin, epoch),
        peers: await peersFor(origin, r),
      };
      await state.scheduler.tick();
    } catch (e) {
      console.warn('[contact-presence] publish failed:', e);
    }
  };

  /** take back this window's beacon for `origin`, if one went out. Never throws. */
  const withdraw = async (origin: string): Promise<void> => {
    const state = scopes.get(origin);
    scopes.delete(origin);
    const epoch = presenceEpoch(nowSeconds());
    if (state?.scheduler.lastPublishedEpoch !== epoch) {
      return;
    }
    try {
      const r = await ready();
      if (r) {
        await state.service.withdrawSelf(await peersFor(origin, r), epoch);
      }
    } catch (e) {
      console.warn('[contact-presence] withdraw failed:', e);
    }
  };

  const drop = (origin: string) => {
    for (const h of holds.get(origin) ?? []) {
      h.close();
    }
    holds.delete(origin);
  };

  return {
    async hold(origin, h) {
      if (!(await granted(origin))) {
        h.close();
        return false;
      }
      const set = holds.get(origin) ?? new Set();
      set.add(h);
      holds.set(origin, set);
      await beacon(origin);
      return true;
    },
    release(origin, h) {
      const set = holds.get(origin);
      set?.delete(h);
      if (set && set.size === 0) {
        // the last page of this site closed: nothing more goes out for it.
        // Its beacon stays in the relay until the window ends, like anyone's.
        holds.delete(origin);
        scopes.delete(origin);
      }
    },
    async tick() {
      for (const origin of [...holds.keys()]) {
        await beacon(origin);
      }
    },
    publishNow: beacon,
    async recheck() {
      const origins = new Set([...holds.keys(), ...scopes.keys()]);
      for (const origin of origins) {
        if (!(await granted(origin).catch(() => false))) {
          await withdraw(origin);
          drop(origin);
        }
      }
    },
    live: () => [...holds.keys()],
  };
};
