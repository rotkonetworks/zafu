/** the names screens and the worker share, with no code behind them */

export const PEOPLE_MESSAGE = 'zafu_people';
export const PEOPLE_WATCH_PORT = 'zafu-people-watch:';
/** chrome.storage.session: the slot under a title */
export const PEOPLE_STATUS_KEY = 'peopleStatus';

/** `673-chaos-mail`: three digits and two words, as the link router reads it */
export const CODE_RE = /^\d{3}-[a-z]{2,12}-[a-z]{2,12}$/;

export const normalizeCode = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, '-');

/** a person's pair room, by their contact id */
export const pairId = (contactId: string) => `p:${contactId}`;
