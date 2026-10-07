/** the names screens and the worker share, with no code behind them */

export const PEOPLE_MESSAGE = 'zafu_people';
export const PEOPLE_WATCH_PORT = 'zafu-people-watch:';
/** chrome.storage.session: the slot under a title */
export const PEOPLE_STATUS_KEY = 'peopleStatus';
/**
 * session storage: who waits at your open doors, per wallet, so the tab can
 * show it without opening the vault. Counts only, never names or keys.
 */
export const PEOPLE_ASKING_KEY = 'peopleAsking';
export interface PeopleAsking {
  walletId: string;
  /** people who typed the code and wait for your zafu to answer */
  n: number;
  /** ms: the door closes */
  until: number;
}

/**
 * The worker's "the relay is gated" errors cross the message boundary as
 * text, so the words live here, once: the throw and every screen that tells
 * them apart read the same constants. Change the copy here and only here.
 */
export const RELAY_NOT_ON = 'the relay is not on yet';
export const RELAY_OFF = 'the relay is off';

/** the relay was never turned on: ask, then try again */
export const isRelayNotOn = (e: unknown): boolean =>
  e instanceof Error && e.message.includes(RELAY_NOT_ON);

/** the relay is not on, either never asked or turned off by the person */
export const isRelayGated = (e: unknown): boolean =>
  e instanceof Error && (e.message.includes(RELAY_NOT_ON) || e.message.includes(RELAY_OFF));

/**
 * `7-fern-dusk`: a number and two words, as the link router reads it. The
 * number names the door's mailbox; the words never leave the device (see
 * people/door.ts).
 */
export const CODE_RE = /^\d{1,3}-[a-z]{2,12}-[a-z]{2,12}$/;

/** the four-part code an older zafu made (`673-chaos-mail-kite`): its maker needs a newer zafu */
export const OLD_CODE_RE = /^\d{3}(?:-[a-z]{2,12}){3}$/;

export const normalizeCode = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, '-');

/** a person's pair room, by their contact id */
export const pairId = (contactId: string) => `p:${contactId}`;
