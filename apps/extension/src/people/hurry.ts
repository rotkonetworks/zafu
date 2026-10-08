/**
 * Which rooms someone is waiting on right now: a code that is open, a group
 * whose newcomer has not been seated yet, a shared wallet still filling or
 * making its keys. While a zafu window is open these are read every
 * {@link FAST_MS} (people/keeper, service watch); everything else keeps its
 * usual pace, and with every window closed nothing is read at all.
 */

import type { PeopleRoom } from './vault';
import { groupId } from './protocol';

/** how often a room someone waits on is read */
export const FAST_MS = 1_000;
/** a newcomer's join is read fast this long after their box went out */
const ARRIVING_MS = 5 * 60_000;
/** a shared wallet fills fast for the hour its first code works */
const FILLING_MS = 60 * 60_000;
/** keys being made are read fast while the ceremony moved within this long */
const KEYS_S = 10 * 60;

/** a roster or key round said lately, for a wallet this device has not saved */
const keysInFlight = (r: PeopleRoom, nowS: number): boolean =>
  (r.frost?.msgs ?? []).some(
    m =>
      ['rs', 'r1', 'r2', 'fvk'].includes(m.body.t) &&
      !r.frost?.mine?.[m.body.id]?.saved &&
      nowS - m.at < KEYS_S,
  );

export const hurried = (rooms: PeopleRoom[], now: number): Set<string> => {
  const out = new Set<string>();
  for (const r of rooms) {
    const d = r.kind === 'door' ? r.door : undefined;
    if (d && (r.until ?? 0) > now && !d.admitted && !d.G && !d.wrong && !d.used) {
      out.add(r.id);
    }
    // the inviter's group reads the joins its codes bring
    if (d?.role === 'host' && r.signer.G) {
      const boxed = d.admitted && d.answered?.find(a => a.jid === d.admitted)?.at;
      if (out.has(r.id) || (boxed && now - boxed < ARRIVING_MS)) {
        out.add(groupId(r.signer.G));
      }
    }
    const g = r.kind === 'group' && r.joined ? r.group : undefined;
    const filling = !!g?.want && g.members.length < g.want.n && now - r.createdAt < FILLING_MS;
    if (filling || (r.joined && keysInFlight(r, Math.floor(now / 1000)))) {
      out.add(r.id);
    }
  }
  return out;
};
