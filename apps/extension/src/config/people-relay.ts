/**
 * The relay people messages ride: group rooms, their doors and pair rooms,
 * all on one egress destination, `people-relay`, asked once at first use.
 *
 * The default is the same bucket relay contact discovery uses (minirelay on
 * relay.zafu.pro, rooms kept 25h). A room may name another relay (a memo invite carries the
 * one its sender chose); every relay beyond the default is listed in plain
 * storage under `peopleRelay.hosts` once the person allowed it, because the
 * egress policy compiles from plaintext settings only.
 *
 * Plain data and no imports: the egress policy reads this in every realm.
 */

export const PEOPLE_RELAY = 'people-relay';

export const DEFAULT_PEOPLE_RELAY = 'https://relay.zafu.pro';

/** chrome.storage.local, plaintext: `{ endpoint?, hosts? }` */
export const PEOPLE_RELAY_KEY = 'peopleRelay';

export interface PeopleRelaySetting {
  /** the default relay for new rooms; blank means {@link DEFAULT_PEOPLE_RELAY} */
  endpoint?: string;
  /** other relays the person allowed for a room, as base urls */
  hosts?: string[];
}

/** a relay as a base url: `https://host[:port]`, no trailing slash */
export const relayBase = (url: string): string | undefined => {
  try {
    const u = new URL(url.trim());
    return /^https?:$/.test(u.protocol) && !u.username && !u.password
      ? `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
      : undefined;
  } catch {
    return undefined;
  }
};

export const defaultPeopleRelay = (s?: PeopleRelaySetting): string =>
  (s?.endpoint && relayBase(s.endpoint)) || DEFAULT_PEOPLE_RELAY;

/** every relay this setting allows: the default first */
export const peopleRelays = (s?: PeopleRelaySetting): string[] => [
  ...new Set([
    defaultPeopleRelay(s),
    ...(Array.isArray(s?.hosts) ? s.hosts : []).flatMap(h =>
      typeof h === 'string' && relayBase(h) ? [relayBase(h)!] : [],
    ),
  ]),
];

/** the host a person sees for a relay */
export const relayHost = (base: string): string => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};
