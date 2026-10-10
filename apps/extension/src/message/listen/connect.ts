/**
 * external message listener - introductions (people/connect).
 *
 *   zafu_connect        an app asks to connect this person with another of its
 *                       people. zafu asks once (ConnectApproval); the answer to
 *                       the app is `pending` either way, so it never learns a no.
 *   zafu_friends        the people this app introduced who are connected now,
 *                       by the key the app already knows them by. Nobody else.
 *   zafu_invite_friend  a line from this app into a friend's private room, said
 *                       as coming from this app.
 *
 * The site is the browser-attested origin, never a field of the message.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes } from '@noble/hashes/utils';
import {
  CONNECT_KA_SUITE,
  type ZafuConnectPeer,
  type ZafuConnectResponse,
  type ZafuFriendsResponse,
  type ZafuInviteFriendResponse,
} from '@zafu/protocol';
import { pqKeyAuthMessage } from '@zafu/pq';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { isValidExternalSender } from '../../senders/external';
import { isValidInternalSender } from '../../senders/internal';
import { readEncryptedWithMigration } from '../../state/encrypted-storage';
import type { Contact } from '../../state/contacts';
import { pairId } from '../../people/protocol';
import { PopupPath } from '../../routes/popup/paths';
import {
  openApprovalPopup,
  registerPendingApproval,
  takePendingApproval,
} from './external-easteregg';
import { CONNECT_INTERNAL_METHODS, CONNECT_METHODS } from './zafu-method-names';

const [CONNECT, FRIENDS, INVITE] = CONNECT_METHODS;
const RESULT = CONNECT_INTERNAL_METHODS[0];

const NOT_AVAILABLE = { error: 'introductions are not available', code: 'not_available' } as const;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

/** the other person's site keys, as the app passed them, if their key signs their KA key */
export const verifiedPeer = (origin: string, p: unknown): ZafuConnectPeer | undefined => {
  const { pubkey, ka, ka_sig } = (p ?? {}) as Partial<Record<keyof ZafuConnectPeer, unknown>>;
  if (typeof pubkey !== 'string' || typeof ka !== 'string' || typeof ka_sig !== 'string') {
    return undefined;
  }
  const peer = { pubkey: pubkey.toLowerCase(), ka: ka.toLowerCase(), ka_sig: ka_sig.toLowerCase() };
  if (!HEX32.test(peer.pubkey) || !HEX32.test(peer.ka) || !HEX64.test(peer.ka_sig)) {
    return undefined;
  }
  try {
    const msg = pqKeyAuthMessage(CONNECT_KA_SUITE, origin, 0, hexToBytes(peer.ka));
    return ed25519.verify(peer.ka_sig, msg, peer.pubkey) ? peer : undefined;
  } catch {
    return undefined;
  }
};

/** a name an app gave, kept short and plain for one line */
export const shortName = (n: unknown): string =>
  typeof n === 'string'
    ? n
        .replace(/[\p{C}]/gu, '')
        .trim()
        .slice(0, 32)
    : '';

/** connected friends this site introduced: their pair room exists */
export const friendsOf = (contacts: Contact[], origin: string, rooms: Set<string>) =>
  contacts
    .filter(c => c.introduced?.origin === origin && rooms.has(pairId(c.id)))
    .map(c => ({ handle: c.introduced!.handle, name: c.name, id: c.id }));

// one ask per minute budget per site, like discovery's
const WINDOW_MS = 60_000;
const MAX_CALLS = 20;
const calls = new Map<string, number[]>();
const limited = (origin: string): boolean => {
  const at = Date.now();
  const recent = (calls.get(origin) ?? []).filter(t => at - t < WINDOW_MS);
  calls.set(origin, [...recent, at]);
  return recent.length >= MAX_CALLS;
};

export interface ConnectDeps {
  locked: () => Promise<boolean>;
  contacts: () => Promise<Contact[]>;
  /** pair rooms this wallet keeps, by id */
  pairRooms: () => Promise<Set<string>>;
  ask: (origin: string, peer: ZafuConnectPeer, name: string) => Promise<void>;
  say: (roomId: string, line: string) => Promise<void>;
}

export const createConnectListener =
  (deps: ConnectDeps) =>
  (
    req: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ): boolean => {
    const type = (req as { type?: unknown } | null)?.type;
    if (type !== CONNECT && type !== FRIENDS && type !== INVITE) {
      return false;
    }
    if (!isValidExternalSender(sender)) {
      sendResponse({ error: 'denied', code: 'denied' });
      return true;
    }
    const origin = sender.origin;
    const r = req as Record<string, unknown>;
    void (async () => {
      try {
        if (limited(origin)) {
          sendResponse({ error: 'too many asks · please wait a minute', code: 'rate_limited' });
          return;
        }
        if (type === CONNECT) {
          const peer = verifiedPeer(origin, r['peer']);
          if (!peer) {
            sendResponse({
              error: "that person's keys could not be read",
              code: 'invalid_request',
            });
            return;
          }
          // a locked wallet still asks: the window opens on unlock, then on the question
          const friend = (await deps.locked())
            ? undefined
            : friendsOf(await deps.contacts(), origin, await deps.pairRooms()).find(
                f => f.handle === peer.pubkey,
              );
          if (friend) {
            sendResponse({
              status: 'connected',
              handle: friend.handle,
            } satisfies ZafuConnectResponse);
            return;
          }
          await deps.ask(origin, peer, shortName(r['name']));
          sendResponse({ status: 'pending' } satisfies ZafuConnectResponse);
          return;
        }
        if (await deps.locked()) {
          sendResponse(NOT_AVAILABLE);
          return;
        }
        const friends = friendsOf(await deps.contacts(), origin, await deps.pairRooms());
        if (type === FRIENDS) {
          sendResponse({
            friends: friends.map(({ handle, name }) => ({ handle, name })),
          } satisfies ZafuFriendsResponse);
          return;
        }
        const handle = typeof r['handle'] === 'string' ? r['handle'].toLowerCase() : '';
        const friend = friends.find(f => f.handle === handle);
        const text = shortName(r['text']);
        const path = typeof r['path'] === 'string' && r['path'].startsWith('/') ? r['path'] : '';
        if (!friend || !text) {
          sendResponse({ error: 'not a friend here', code: 'invalid_request' });
          return;
        }
        await deps.say(pairId(friend.id), `${text} · ${origin}${path}`);
        sendResponse({ sent: true } satisfies ZafuInviteFriendResponse);
      } catch {
        sendResponse(NOT_AVAILABLE);
      }
    })();
    return true;
  };

/** the question, once: resolves when the person answered or closed the window */
const askOnce = async (origin: string, peer: ZafuConnectPeer, name: string): Promise<void> => {
  const requestId = crypto.randomUUID();
  const done = new Promise<void>(resolve => registerPendingApproval(requestId, () => resolve()));
  const params = new URLSearchParams({ app: origin, requestId, name, ...peer });
  const url = `${chrome.runtime.getURL('popup.html')}#${PopupPath.CONNECT_APPROVAL}?${params.toString()}`;
  if (!(await openApprovalPopup(origin, url, requestId))) {
    takePendingApproval(requestId);
    return;
  }
  await done;
};

export const connectDeps = (say: ConnectDeps['say']): ConnectDeps => ({
  locked: async () => !(await sessionExtStorage.get('passwordKey')),
  contacts: async () =>
    (await readEncryptedWithMigration<Contact[]>(localExtStorage, sessionExtStorage, 'contacts')) ??
    [],
  pairRooms: async () => {
    const { readRooms } = await import('../../people/vault');
    return new Set(((await readRooms()) ?? []).filter(x => x.kind === 'pair').map(x => x.id));
  },
  ask: askOnce,
  say,
});

/** internal popup->worker: the connect window is done (said yes, or not now) */
export const connectResultListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean => {
  if ((req as { type?: unknown } | null)?.type !== RESULT || !isValidInternalSender(sender)) {
    return false;
  }
  takePendingApproval(String((req as { requestId?: unknown }).requestId ?? ''))?.({});
  sendResponse({ ok: true });
  return true;
};
