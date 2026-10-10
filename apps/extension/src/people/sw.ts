/**
 * The people relay service, wired into the service worker: its vault, the
 * keys it signs with, its egress gate and the windows it lives with.
 *
 * Screens talk to it with one internal message, `zafu_people`, and one port
 * per open thread (`zafu-people-watch:<room id>`). It never starts itself:
 * installing, unlocking, opening the popup or starting the worker does
 * nothing here. The first call is the person opening people.
 */

import { createHttpRelayTransport } from '@zafu/zid';
import { relayLimitsFor } from '@zafu/zirc/room';
import { identityOf } from './keys';
import { useStore } from '../state';
import {
  deriveRelationshipKeys,
  deriveRoomKeys,
  getZidIndex,
  type RelationshipKeys,
  type XidKeys,
} from '../state/identity';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration } from '../state/encrypted-storage';
import type { Contact } from '../state/contacts';
import { createPairs } from './pairs';
import { createInvites } from './invites';
import { createGroups } from './groups';
import { createCards } from './cards';
import { foldFrost, frostOps } from './frost-room';
import { onDealAsk } from './deal';
import { createLeaderless } from './lx';
import { compileEgress, describeEgress, type EgressInputs } from '../net/egress-policy';
import { decideEgress } from '../net/egress-table';
import { readEgressInputs } from '../net/egress-opt-in';
import {
  PEOPLE_RELAY,
  PEOPLE_RELAY_KEY,
  defaultPeopleRelay,
  peopleRelays,
  type PeopleRelaySetting,
} from '../config/people-relay';
import {
  PEOPLE_ASKING_KEY,
  PEOPLE_MESSAGE,
  PEOPLE_STATUS_KEY,
  PEOPLE_WATCH_PORT,
  type PeopleAsking,
} from './protocol';
import { onOnline } from '../sw-online';
import { connectOps, onConnect } from './connect';
import { readRooms, readThreads, writeRooms, writeThreads, type PeopleRoom } from './vault';
import {
  chain,
  createPeopleService,
  type Gate,
  type PeopleDeps,
  type RecordHandler,
} from './service';

/** the session flag (design-social 2.10): set at T1, cleared at the last close */
const SESSION_FLAG = 'peopleSession';

/** may this relay be contacted right now (people-relay on, and this relay allowed) */
export const peopleGate = (i: EgressInputs, relay: string): Gate => {
  const view = describeEgress(i).find(d => d.id === PEOPLE_RELAY);
  if (view?.why === 'you-blocked') {
    return 'blocked';
  }
  if (!view?.on || !peopleRelays(i.peopleRelay).includes(relay)) {
    return 'ask';
  }
  const d = decideEgress(`${relay}/bucket`, 'service-worker', compileEgress(i));
  return d.allow ? 'on' : d.reason === 'blocked' ? 'blocked' : 'ask';
};

/** keys derived for a room, kept for the session only */
const keys = new Map<string, XidKeys>();

const roomKeys = async (walletId: string, gen: number, G: string): Promise<XidKeys> => {
  const id = `${walletId}/${gen}/g/${G}`;
  const cached = keys.get(id);
  if (cached) {
    return cached;
  }
  const k = deriveRoomKeys(await useStore.getState().keyRing.getMnemonic(walletId), gen, G);
  keys.set(id, k);
  return k;
};

const relKeys = async (walletId: string, gen: number, j: number): Promise<RelationshipKeys> => {
  const id = `${walletId}/${gen}/j/${j}`;
  const cached = keys.get(id) as RelationshipKeys | undefined;
  if (cached) {
    return cached;
  }
  const k = deriveRelationshipKeys(await useStore.getState().keyRing.getMnemonic(walletId), gen, j);
  keys.set(id, k);
  return k;
};

export const keysFor = (room: PeopleRoom): Promise<XidKeys> =>
  room.signer.j !== undefined
    ? relKeys(room.walletId, room.signer.gen, room.signer.j)
    : room.signer.G !== undefined
      ? roomKeys(room.walletId, room.signer.gen, room.signer.G)
      : Promise.reject(new Error('this room has no key yet'));

const pairs = createPairs({
  walletId: async () => useStore.getState().keyRing.selectedKeyInfo?.id,
  contacts: async () =>
    (await readEncryptedWithMigration<Contact[]>(localExtStorage, sessionExtStorage, 'contacts')) ??
    [],
  relKeys,
  relay: () => defaultRelay(),
});

const defaultRelay = async () =>
  defaultPeopleRelay(
    (await chrome.storage.local.get(PEOPLE_RELAY_KEY))[PEOPLE_RELAY_KEY] as
      | PeopleRelaySetting
      | undefined,
  );

const invites = createInvites({
  walletId: async () => useStore.getState().keyRing.selectedKeyInfo?.id,
  contacts: async () =>
    (await readEncryptedWithMigration<Contact[]>(localExtStorage, sessionExtStorage, 'contacts')) ??
    [],
  roomKeys,
  generation: walletId => getZidIndex(walletId),
  relay: () => defaultRelay(),
});

const groups = createGroups({
  walletId: async () => useStore.getState().keyRing.selectedKeyInfo?.id,
  keys: roomKeys,
  generation: walletId => getZidIndex(walletId),
  relay: () => defaultRelay(),
  gate: relay => peopleDeps.gate(relay),
});

const cards = createCards({
  walletId: async () => useStore.getState().keyRing.selectedKeyInfo?.id,
  relKeys,
  gate: relay => peopleDeps.gate(relay),
});

const lx = createLeaderless({ keys: room => keysFor(room), now: () => Date.now() });

/**
 * People waiting at your open codes, as counts (the tab's badge reads these):
 * someone typed a code and is not in yet. A code lets one person in, so
 * each counts once, however many runs spoke to it.
 */
export const askingOf = (rooms: PeopleRoom[]): PeopleAsking[] =>
  rooms.flatMap(r => {
    const d = r.kind === 'door' && r.door?.role === 'host' ? r.door : undefined;
    const waiting =
      d && !d.admitted && d.heard.some(h => h.wire.kind === 'wj' && h.wire.salt === d.salt);
    return waiting && r.until ? [{ walletId: r.walletId, n: 1, until: r.until }] : [];
  });

export const peopleDeps: PeopleDeps = {
  readRooms,
  writeRooms: async rooms => {
    const ok = await writeRooms(rooms);
    await chrome.storage.session.set({ [PEOPLE_ASKING_KEY]: askingOf(rooms) });
    return ok;
  },
  readThreads,
  writeThreads,
  walletId: async () => useStore.getState().keyRing.selectedKeyInfo?.id,
  identity: async room => identityOf(await keysFor(room)),
  gate: async relay => peopleGate(await readEgressInputs(), relay),
  transport: (relay, size, signal) =>
    createHttpRelayTransport({
      endpoint: relay,
      ...relayLimitsFor(size),
      fetch: (input, init) => fetch(input, { ...init, signal }),
    }),
  status: s => chrome.storage.session.set({ [PEOPLE_STATUS_KEY]: s }),
  online: () => navigator.onLine,
};

export type PeopleOp = (
  req: Record<string, unknown>,
  service: ReturnType<typeof createPeopleService>,
) => Promise<unknown>;

/**
 * Start the service in this worker. `ops` and `handlers` are what each room
 * kind adds (groups, pair rooms). Returns the hooks for the windows' session.
 */
export const startPeopleRelay = (
  ops: Record<string, PeopleOp> = {},
  handlers: Partial<Record<PeopleRoom['kind'], RecordHandler>> = {},
) => {
  const service = createPeopleService(peopleDeps, {
    ...groups.handlers,
    card: cards.handlers.card,
    connect: onConnect,
    ...handlers,
    group: chain(handlers.group ?? groups.handlers.group, lx.handler(foldFrost)),
    pair: chain(handlers.pair ?? invites.handlers.pair, cards.handlers.pair, foldFrost, onDealAsk),
  });
  const all: Record<string, PeopleOp> = {
    open: async (_, s) => {
      await chrome.storage.session.set({ [SESSION_FLAG]: true });
      return s.open();
    },
    check: (_, s) => s.check(),
    say: (r, s) =>
      s.say(
        String(r['roomId']),
        String(r['text'] ?? ''),
        typeof r['retry'] === 'string' ? r['retry'] : undefined,
      ),
    read: (r, s) => s.read(String(r['roomId'])),
    ...groups.ops,
    ...pairs.ops,
    ...invites.ops,
    ...cards.ops,
    ...frostOps,
    ...lx.ops,
    ...connectOps,
    ...ops,
  };

  chrome.runtime.onMessage.addListener((req, sender, respond) => {
    const r = req as { type?: unknown; op?: unknown } | null;
    if (r?.type !== PEOPLE_MESSAGE || typeof r.op !== 'string') {
      return false;
    }
    // only zafu's own pages: a content script or another extension never reaches this
    if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith('http')) {
      return false;
    }
    const op = all[r.op];
    if (!op) {
      respond({ ok: false, error: 'unknown op' });
      return false;
    }
    void op(r as Record<string, unknown>, service).then(
      value => respond({ ok: true, value }),
      (e: unknown) => respond({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  });

  // back online while people is open: what waited to leave goes now; closed, nothing runs
  onOnline(() => {
    if (service.active) {
      void service.flush().catch(() => undefined);
    }
  });

  chrome.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith(PEOPLE_WATCH_PORT) || port.sender?.id !== chrome.runtime.id) {
      return;
    }
    const stop = service.watch(port.name.slice(PEOPLE_WATCH_PORT.length));
    port.onDisconnect.addListener(stop);
  });

  return {
    service,
    /** with the windows: a worker that restarted under an open people tab carries on (T3) */
    hooks: {
      resume: () =>
        void chrome.storage.session.get(SESSION_FLAG).then(v => {
          if (v[SESSION_FLAG] === true && !service.active) {
            void service.open().catch(() => undefined);
          }
        }),
      pause: () => {
        service.close();
        keys.forEach(k => {
          k.seed.fill(0);
          k.xwingSeed.fill(0);
          (k as Partial<RelationshipKeys>).kaSeed?.fill(0);
        });
        keys.clear();
        void chrome.storage.session.remove(SESSION_FLAG);
      },
    },
  };
};
