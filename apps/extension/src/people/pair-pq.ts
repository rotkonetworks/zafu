/**
 * Post-quantum pair rooms. A pair room starts on X25519 of the two
 * relationship keys (people/pairs): a recording of it would open to a
 * quantum computer later. Once both cards say `Cap.pq`, the room moves to a
 * hybrid secret, in the first room:
 *
 *   the higher XID posts its relationship X-Wing key   zp2:pq-key:<b64url>
 *   the lower XID seals S to it, and moves              zp2:pq-box:<b64url>
 *   the higher XID opens S, moves, and says so there    zp2:pq-ok
 *
 *   S      = HKDF(sealer's X-Wing seed, salt "zafu-pair-pq-v1", info peer XID)
 *   secret = HKDF(x25519 secret || S, salt "zafu-pair-v2", info min(XID) || max(XID))
 *
 * X-Wing is ML-KEM-768 and X25519 together, so the room is as strong as the
 * stronger of the two. S comes from the sealer's seed and the box is public,
 * kept on the contact: either side rebuilds the room from its phrase.
 *
 * The relay keeps a record 48 h, so the key and the box are said again each
 * {@link RESEND_MS} until the other side answers. Lines wait to leave until
 * the move; an older zafu never says `Cap.pq` and the room stays as it was.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { openXWing, sealXWing, XWING_LENGTHS } from '@zafu/pq';
import { presenceEpoch } from '@zafu/zid';
import { Cap, cardB64, fromB64url, readCardV2 } from '@repo/wallet/networks/zcash/card-v2';
import { pairSecret, xidOf, type RelationshipKeys } from '../state/identity';
import type { RecordHandler } from './service';
import type { PeopleRoom } from './vault';

export const PQ_KEY = 'zp2:pq-key:';
export const PQ_BOX = 'zp2:pq-box:';
export const PQ_OK = 'zp2:pq-ok';

/** under the relay's 48 h, so a key or a box is always there to find */
export const RESEND_MS = 20 * 3600_000;

const enc = new TextEncoder();
const capsOf = (b64?: string) => {
  try {
    return (b64 && readCardV2(fromB64url(b64))?.caps) || 0;
  } catch {
    return 0;
  }
};

/** their card says they move pair rooms to post-quantum */
export const wantsPq = (room: PeopleRoom): boolean =>
  room.kind === 'pair' && !!room.pair?.peer && (capsOf(room.pair.v2?.latest) & Cap.pq) !== 0;

/** the room has not moved yet: lines wait */
export const securing = (room: PeopleRoom): boolean => wantsPq(room) && !room.pair?.pq?.box;

/** still something to do: move, or (sealer) hear that they moved too */
export const needsPq = (room: PeopleRoom): boolean =>
  wantsPq(room) && (!room.pair?.pq?.box || !room.pair.pq.ok);

/** the lower XID seals */
const sealsFirst = (me: string, peer: string) => xidOf(me) < xidOf(peer);

const aadOf = (sealer: string, opener: string) =>
  new Uint8Array([...enc.encode('zafu-pair-pq-v1'), ...hexToBytes(sealer), ...hexToBytes(opener)]);

const seedFor = (xwingSeed: Uint8Array, peer: string) =>
  hkdf(sha256, xwingSeed, enc.encode('zafu-pair-pq-v1'), hexToBytes(xidOf(peer)), 32);

const hybrid = (classical: string, s: Uint8Array, me: string, peer: string): string => {
  const [lo, hi] = [xidOf(me), xidOf(peer)].sort();
  const ikm = new Uint8Array([...hexToBytes(classical), ...s]);
  const out = bytesToHex(hkdf(sha256, ikm, enc.encode('zafu-pair-v2'), hexToBytes(lo! + hi!), 32));
  ikm.fill(0);
  s.fill(0);
  return out;
};

type Keys = Pick<RelationshipKeys, 'kaSeed' | 'xid' | 'xwingSeed'>;

/** S, from your own seed when you sealed it, else out of their box; throws when it does not open */
const secretOf = (keys: Keys, box: string, me: string, peer: string): Uint8Array =>
  sealsFirst(me, peer)
    ? seedFor(keys.xwingSeed, peer)
    : openXWing(keys.xwingSeed, fromB64url(box), aadOf(peer, me));

/** the moved secret, from the first one and the box: what a rebuilt room is keyed by */
export const pqSecret = (classical: string, keys: Keys, box: string, me: string, peer: string) =>
  hybrid(classical, secretOf(keys, box, me, peer), me, peer);

/** the first room's secret, from their card */
const classicalOf = (room: PeopleRoom, keys: Keys): string | undefined => {
  const theirs = readCardV2(fromB64url(room.pair?.v2?.latest ?? ''));
  return theirs
    ? bytesToHex(pairSecret(keys.kaSeed, theirs.pairKa, keys.xid, xidOf(room.pair!.peer!)))
    : undefined;
};

export interface PairPqDeps {
  relKeys: (walletId: string, gen: number, j: number) => Promise<RelationshipKeys>;
  now: () => number;
}

export const createPairPq = (deps: PairPqDeps): RecordHandler => {
  const pq = (room: PeopleRoom) => room.pair?.pq ?? {};
  const patch =
    (p: NonNullable<NonNullable<PeopleRoom['pair']>['pq']>) =>
    (r: PeopleRoom): PeopleRoom => ({ ...r, pair: { ...r.pair!, pq: { ...r.pair!.pq, ...p } } });

  return async (room, records, api) => {
    const peer = room.pair?.peer;
    const theirs = records.filter(m => m.author === peer);
    // a pq line of theirs says they speak it, before their card did
    if (
      !peer ||
      room.signer.j === undefined ||
      !(needsPq(room) || theirs.some(m => m.body.startsWith('zp2:pq-')))
    ) {
      return undefined;
    }
    const me = await api.me(room);
    // the worker keeps relationship keys cached: borrowed here, never wiped
    const keys = await deps.relKeys(room.walletId, room.signer.gen, room.signer.j);
    const t = deps.now();
    const at = pq(room).at ?? 0;
    const move = async (box: string, since: number, more: { at?: number; ok?: boolean }) => {
      const secret = pqSecret(room.secret, keys, box, me, peer);
      await api.updateRoom(room.id, r => ({
        ...r,
        secret,
        head: undefined,
        since,
        pair: { ...r.pair!, pq: { box, ...more } },
      }));
    };

    if (pq(room).box) {
      // sealer, moved: until a line of theirs lands here, the box is said again in the first room
      if (theirs.length) {
        return patch({ ok: true });
      }
      const first = classicalOf(room, keys);
      if (t - at < RESEND_MS || !first) {
        return undefined;
      }
      await api.post({ ...room, secret: first, head: undefined }, PQ_BOX + pq(room).box);
      return patch({ at: t });
    }

    if (sealsFirst(me, peer)) {
      const key = theirs.findLast(m => m.body.startsWith(PQ_KEY));
      const pub = key && fromB64url(key.body.slice(PQ_KEY.length));
      if (!pub || pub.length !== XWING_LENGTHS.publicKey) {
        return undefined;
      }
      const s = seedFor(keys.xwingSeed, peer);
      const box = cardB64(sealXWing(pub, s, aadOf(me, peer)));
      s.fill(0);
      await api.send(room.id, PQ_BOX + box, 'action');
      await move(box, presenceEpoch(Math.floor(t / 1000)), { at: t });
      return undefined;
    }

    const box = theirs.findLast(m => m.body.startsWith(PQ_BOX));
    if (box) {
      try {
        // from as far back as the relay keeps: a box said again is later than their first lines there
        await move(box.body.slice(PQ_BOX.length), 0, { ok: true });
        await api.send(room.id, PQ_OK, 'action');
        return undefined;
      } catch {
        // not a box for this room: wait for the next
      }
    }
    if (t - at < RESEND_MS) {
      return undefined;
    }
    const { xwingPublicKey } = keys;
    await api.send(room.id, PQ_KEY + cardB64(hexToBytes(xwingPublicKey)), 'action');
    return patch({ at: t });
  };
};
