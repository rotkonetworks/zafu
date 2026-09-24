/**
 * Friends, kept where the rest of this identity's social graph is kept.
 *
 * A friend is a `@zafu/zid` contact: pubkey, display name, and the app-scoped
 * handle that the SDK derives so the same person is unlinkable across apps. The
 * store is local to this browser (localStorage), which is exactly the point - the
 * room rotates every five minutes, the relay keeps an hour, and a friend list
 * that lived in either would be gone by tomorrow. It is also the same store the
 * wallet can hand back through `pickContacts`, so a Zafu user's contact list and
 * this one are one list.
 *
 * What a friend is not, yet: a channel to them. The pairwise root secret that
 * would carry a direct message outside a shared room (`establishContactSecret`)
 * needs the peer's contact card, and a room record does not carry one - so a
 * friend persists as a name and a key to recognise them by, and a `/msg` still
 * needs a room you are both in.
 */

import {
  contactCount,
  getContactRefs,
  removeContact,
  resolveHandle,
  upsertContact,
} from '@zafu/zid';
import { shortId } from './commands';

export interface Friend {
  pubkey: string;
  label: string;
  /** the app-scoped handle this friend answers to, hex. */
  handle: string;
}

/** add (or re-name) a friend. Synchronous, because the store is local. */
export const addFriend = (member: { pubkey: string; name: string }): void => {
  upsertContact(member.pubkey, member.name.trim() || shortId(member.pubkey));
};

/** forget a friend, and the pairwise secret cached for them with it. */
export const forgetFriend = (pubkey: string): void => {
  removeContact(pubkey);
};

/** everyone this app knows, newest name wins. */
export const listFriends = async (appOrigin: string): Promise<Friend[]> => {
  const refs = await getContactRefs(appOrigin);
  const friends: Friend[] = [];
  for (const ref of refs) {
    const pubkey = resolveHandle(ref.handle, appOrigin);
    if (!pubkey) continue;
    friends.push({ pubkey, label: ref.displayName || shortId(pubkey), handle: ref.handle });
  }
  return friends;
};

export const friendCount = (): number => contactCount();
