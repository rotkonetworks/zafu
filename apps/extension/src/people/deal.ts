/**
 * Deals between two people (DealPropose, Cv2DealSet, Cv2Escrow). Making one
 * waits for #110 to say how its terms bind with no leader; what is read here
 * is an invite into a deal group an older zafu sent through a pair room,
 * whose code opens the door as any group's does.
 */

import { decodeWire } from './door';
import type { RecordHandler } from './service';

/** a pair room: the other person asked you into their deal group */
export const onDealAsk: RecordHandler = async (room, records) => {
  const asked = records
    .flatMap(m => {
      const w = decodeWire(m.body);
      return w?.kind === 'dj' && m.author === room.pair?.peer
        ? [{ code: w.code, group: w.group, at: m.ts }]
        : [];
    })
    .at(-1);
  return asked && asked.at > (room.pair?.deal?.at ?? 0)
    ? r => ({ ...r, pair: { ...r.pair!, deal: asked } })
    : undefined;
};
