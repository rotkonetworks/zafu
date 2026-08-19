/**
 * @zafu/zid — zafu identity SDK
 *
 * one-line wallet connection, session signing, e2ee channels.
 *
 * ```typescript
 * import { zid } from '@zafu/zid'
 *
 * const me = await zid.connect()
 * const sig = await me.sign(data)
 * const ch = await me.channel(peerPubkey)
 * ch.send('hello')
 * ```
 */

export { zid } from './zid';
export { createNoiseChannel } from './noise-channel';
export {
  upsertContact,
  removeContact,
  getContactRefs,
  resolveHandle,
  contactCount,
  importFromWallet,
  establishContactSecret,
  getContactRootSecret,
} from './contacts';
export type {
  ZidIdentity,
  ZidChannel,
  ZidOptions,
  ContactRef,
  ContactCardKey,
  ContactShare,
  PickContactsOptions,
  InvitePayload,
  InviteResult,
  IncomingInvite,
} from './types';

export { encodeNoiseInitMemo, decodeNoiseInitMemo, isNoiseInitMemo } from './noise-init-memo';
export type { NoiseInitPayload } from './noise-init-memo';

export { encodeSealedRemark, decodeSealedRemark, isSealedRemark } from './sealed-remark';

export {
  jamTimeslot,
  presenceEpoch,
  rendezvousTag,
  JAM_COMMON_ERA,
  JAM_SLOT_DURATION,
  PRESENCE_EPOCH_SLOTS,
  RENDEZVOUS_TAG_BYTES,
} from './contact-discovery';

export {
  sealPresence,
  openPresence,
  encodePresenceRecord,
  decodePresenceRecord,
  PRESENCE_BLOB_VERSION,
  PRESENCE_RECORD_VERSION,
} from './presence-blob';
export type { PresenceDir, PresenceRecord } from './presence-blob';

export {
  expectedFriendTags,
  matchBucket,
  ContactRelay,
  PRESENCE_PAD_TO,
  PRESENCE_BLOB_BYTES,
} from './contact-relay';
export type {
  PresenceEntry,
  RelayTransport,
  RandomBytes,
  ContactRelayOptions,
  PresentFriend,
  FriendPresenceQuery,
  PublishOutcome,
} from './contact-relay';

export { createPresenceService } from './presence-service';
export type { PresenceService, DiscoveryPeer, PresentPeer } from './presence-service';
