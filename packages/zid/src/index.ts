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

export { zid } from './zid'
export { createNoiseChannel } from './noise-channel'
export { upsertContact, removeContact, getContactRefs, resolveHandle, contactCount } from './contacts'
export type {
  ZidIdentity, ZidChannel, ZidOptions,
  ContactRef, PickContactsOptions, InvitePayload, InviteResult, IncomingInvite,
} from './types'

export {
  encodeNoiseInitMemo, decodeNoiseInitMemo, isNoiseInitMemo,
} from './noise-init-memo'
export type { NoiseInitPayload } from './noise-init-memo'

export {
  encodeSealedRemark, decodeSealedRemark, isSealedRemark,
} from './sealed-remark'
