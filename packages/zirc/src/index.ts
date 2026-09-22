/**
 * @zafu/zirc - IRC-style channels on zid.
 *
 * zid is the identity and transport layer: keys, sealed boxes, pairwise
 * encrypted channels, presence. zirc is what a community builds on top: a
 * channel with a founder, an operator set, an electorate that can be audited, and
 * moderation that hides rather than deletes.
 *
 * The pieces, all pure functions over signed records:
 *
 *   channel-log.ts  genesis, the hash-chained log, and authority verification
 *   vote.ts         the electorate at a log index, and whether a decision passed
 *
 * And re-exported from zid because a channel needs it: the round-structured group
 * session that carries coordination messages over pairwise channels.
 *
 * Nothing here talks to a network. Where the log lives (a relay scope, an
 * append-only service, content-addressed storage mirrored by clients) is the
 * application's decision - issues #46 and #47 in the repo - and every function
 * here is agnostic to it.
 */

export {
  appendRecord,
  channelStateAt,
  createGenesis,
  decisionView,
  genesisHash,
  recordBytes,
  recordHash,
  verifyChain,
} from './channel-log';
export type {
  ChainCheck,
  ChannelBody,
  ChannelGenesis,
  ChannelRecord,
  ChannelSigner,
  DecisionView,
} from './channel-log';

export { DEFAULT_RULES, itemIsHidden, modeStateAt, tallyDecision } from './vote';
export type { ModeRecord, ModerationRules, Tally, VoteRecord } from './vote';

// the messaging substrate a channel sits on: rounds over pairwise channels,
// implemented in zid because ceremonies (FROST) need it too
export {
  createGroupSession,
  decodeGroupEnvelope,
  encodeGroupEnvelope,
  signedBytes,
} from '@zafu/zid';
export type { GroupEnvelope, GroupMember, GroupSession, RoundStatus } from '@zafu/zid';
