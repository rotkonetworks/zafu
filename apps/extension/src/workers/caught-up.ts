/**
 * Whether a store has scanned far enough to pick notes from.
 *
 * Only the pocket on screen syncs, so another pocket's store can stand far
 * below the tip. Its notes then include ones already spent elsewhere (another
 * zafu with the same phrase, another device), and the chain refuses the send
 * as a double spend. A caught-up store trails the tip by at most the one block
 * that landed since its last poll.
 */
export const CAUGHT_UP_BLOCKS = 1;

export const isCaughtUp = (syncHeight: number, tipHeight: number): boolean =>
  syncHeight > 0 && syncHeight >= tipHeight - CAUGHT_UP_BLOCKS;

export const NOT_CAUGHT_UP =
  'zafu is still catching up with the chain · nothing was sent. please try again in a moment';
