/**
 * Deals between two people (DealPropose, Cv2DealSet, Cv2Escrow): a shared
 * wallet made in their pair room, 2 of 2 by default. With zafu court it is
 * 2 of 3 and the court's seat waits for the escrow service. With someone you
 * both trust deciding, the three need one room: zafu makes a small deal group
 * and hands its door code to both through their pair rooms, so neither types
 * a code; the founder still allows each person, as in any group.
 */

import { decodeWire, encodeWire } from './door';
import { pairId } from './protocol';
import type { Deal } from './frost-room';
import { groupId } from './groups';
import type { PeopleService, RecordHandler } from './service';

export const createDeals = (deps: {
  group: (svc: PeopleService, name: string) => Promise<{ id: string; code: string }>;
}) => ({
  ops: {
    /** a deal group with these contacts: made, its code said in each pair room */
    'deal-group': async (r: Record<string, unknown>, svc: PeopleService) => {
      const ids = Array.isArray(r['contactIds']) ? r['contactIds'].map(String) : [];
      const deal = r['deal'] as Deal;
      const rooms = await Promise.all(ids.map(id => svc.api.room(pairId(id))));
      if (ids.length !== 2 || rooms.some(x => !x?.joined) || !deal?.what) {
        throw new Error('both need a chat with you first');
      }
      const made = await deps.group(svc, deal.what);
      await svc.api.updateRoom(made.id, x => ({ ...x, group: { ...x.group!, deal } }));
      for (const room of rooms) {
        await svc.api.send(
          room!.id,
          encodeWire({ kind: 'dj', code: made.code, group: deal.what }),
          'action',
        );
      }
      return { ...made, G: made.id.slice(groupId('').length) };
    },
  },
  /** a pair room: the other person asked you into their deal group */
  onPair: (async (room, records) => {
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
  }) satisfies RecordHandler,
});
