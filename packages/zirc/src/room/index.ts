/**
 * `@zafu/zirc/room` - the substrate a channel actually sits on.
 *
 * The package root is pure: genesis, modes, votes and tallies are functions
 * over signed records, and nothing there talks to a network. That is worth
 * keeping, so the half that does talk to a network lives here instead of
 * being mixed into it.
 *
 * What this is: N members, one shared room secret, and a windowed append-only
 * board the relay cannot read. It rides the transport a zafu relay already
 * speaks for contact discovery - `putBucket`/`getBucket` keyed by
 * `(appScope, epoch, shard)` - so a room needs no new server behaviour and no
 * relay cooperation. A bouncer in front changes nothing: it is HTTP, and it is
 * blind by construction because the relay behind it is.
 *
 * Read `room.ts` for what it guarantees and, more usefully, what it does not:
 * no forward secrecy past the window, no global order, no hiding of traffic
 * shape. Moderation is the package root's job - a decision there is a signed
 * record rather than a deletion, and it needs durable storage, because
 * replaying who is an operator means replaying the log from genesis and these
 * windows sweep.
 */

export {
  Room,
  createRoomSecret,
  encodeInvite,
  parseInvite,
  hkdfBytes,
  roomShard,
  plainTag,
  maxBodyBytes,
  DEFAULT_CHANNEL,
  INVITE_PREFIX,
  LEGACY_INVITE_PREFIX,
  ROOM_VERSION,
  ROOM_PLAINTEXT_BYTES,
} from './room';
export type {
  RoomConfig,
  RoomIdentity,
  RoomInvite,
  RoomKind,
  RoomMessage,
  RoomPresence,
  RoomSync,
  DropKind,
  MessageKind,
} from './room';

export {
  COMMANDS,
  complete,
  helpText,
  isValidNick,
  parseLine,
  resolveMember,
  shortId,
  whoText,
} from './commands';
export type { Candidate, CommandSpec, Completion, Member, ParsedLine } from './commands';

export { listFriends } from './friends';
export type { Friend } from './friends';

/**
 * How often to read the current window.
 *
 * A presence epoch is five minutes, so this is not about freshness of
 * presence - it is how long a message waits before a peer sees it.
 */
export const ROOM_POLL_MS = 4_000;

/** How many windows back a join reads, so a new member arrives to a room with history. */
export const ROOM_HISTORY_WINDOWS = 12;
