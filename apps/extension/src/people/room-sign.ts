/**
 * Spending from a shared wallet in its room (Group.dc.html: "proposal · by
 * bob", "review and seal"). The same rounds as multisig/sign.tsx, carried as
 * room records instead of a frostd session:
 *
 *   prop  the proposer built the PCZT; every member reviews it on their own
 *         device (review.ts: sighash recomputed, outputs decrypted)
 *   c     "review and seal": a member's round-one commitments, one per spend;
 *         the nonces stay sealed in this device's room vault
 *   no    "decline": said, never a veto
 *   set   the proposer: the first `threshold` who sealed, itself first
 *   s     each of them: round-two shares, released on its own once the set
 *         names it (it already agreed to exactly this PCZT); the nonces go
 *   sent  the proposer: aggregated, completed and broadcast, as this txid
 *
 * What a member seals is what it signs, and nothing else:
 *   - a payment's id is a hash of all it says and of its proposer (see
 *     frost-room propId), so no other payment and no other member can be said
 *     under it; the first copy is the one read;
 *   - "review and seal" keeps a hash of exactly what was reviewed, and a
 *     device signs only while the payment still hashes to it;
 *   - only the proposer names the signers, once: a second, different list
 *     stops the payment instead of replacing the first;
 *   - a signer posts the shares it kept, never ones it made again.
 *
 * A proposal is one PCZT, so it lives as long as the transaction's expiry
 * (about two hours): sealing an intent ahead of the build is what is left to
 * do for members who come by later.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { packFrost, readMsgs, type FrostIo, type FrostMine, type FrostMsg } from './frost-room';

export interface Proposal {
  id: string;
  /** the shared wallet it spends from (its ceremony) */
  w: string;
  by: string;
  /** seconds */
  at: number;
  to: string;
  amt: string;
  fee: string;
  sighash: string;
  alphas: string[];
  si: number[];
  pczt: string;
  commits: Map<string, string[]>;
  no: Set<string>;
  set?: string[];
  shares: Map<string, string[]>;
  sent?: string;
  /** the proposer named two different signer lists: nobody signs it */
  split?: boolean;
}

/** what a member reviews in a payment */
export type Reviewed = Pick<
  Proposal,
  'id' | 'w' | 'by' | 'to' | 'amt' | 'fee' | 'sighash' | 'alphas' | 'si' | 'pczt'
>;

/** the hash "review and seal" keeps: a device signs only a payment that still hashes to it */
export const reviewOf = (p: Reviewed): string =>
  bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          'zafu-frost-review-v1',
          p.id,
          p.w,
          p.by,
          p.to,
          p.amt,
          p.fee,
          p.sighash,
          p.alphas,
          p.si,
          p.pczt,
        ]),
      ),
    ),
  );

/** the shared wallet a room's payments spend from, as its seat records it */
export interface RoomWallet {
  ceremony: string;
  members: string[];
  threshold: number;
}

/**
 * The payments proposed from this wallet, oldest first, read from its members
 * only. A payment is said by its own proposer (its id binds them); the first
 * of each record per member counts, and a member's second, different
 * commitments or shares are not counted at all.
 */
export const proposalsOf = (msgs: FrostMsg[] | undefined, w: RoomWallet): Proposal[] => {
  const all = readMsgs(msgs);
  const props = new Map<string, Proposal>();
  for (const { from, at, body } of all) {
    if (
      body.t === 'prop' &&
      body.w === w.ceremony &&
      body.by === from &&
      w.members.includes(from) &&
      !props.has(body.id)
    ) {
      props.set(body.id, {
        id: body.id,
        w: body.w,
        by: from,
        at,
        to: body.to,
        amt: body.amt,
        fee: body.fee,
        sighash: body.sighash,
        alphas: body.alphas,
        si: body.si,
        pczt: body.pczt,
        commits: new Map(),
        no: new Set(),
        shares: new Map(),
      });
    }
  }
  const twice = new Set<string>();
  const said = new Map<string, string>();
  for (const { from, body } of all) {
    const p = props.get(body.id);
    if (!p || !w.members.includes(from) || body.t === 'prop') {
      continue;
    }
    const key = `${p.id}:${from}:${body.t}`;
    const now = JSON.stringify(body);
    const before = said.get(key);
    if (before !== undefined) {
      if (before !== now) {
        twice.add(key);
      }
      continue;
    }
    said.set(key, now);
    const n = p.alphas.length;
    if (body.t === 'c' && body.c.length === n) {
      p.commits.set(from, body.c);
    } else if (body.t === 's' && body.s.length === n) {
      p.shares.set(from, body.s);
    } else if (body.t === 'no') {
      p.no.add(from);
    } else if (
      body.t === 'set' &&
      from === p.by &&
      body.m.length === w.threshold &&
      body.m.every(m => w.members.includes(m))
    ) {
      p.set = body.m;
    } else if (body.t === 'sent' && from === p.by) {
      p.sent = body.tx;
    }
  }
  for (const key of twice) {
    const [id, from, t] = key.split(':') as [string, string, string];
    const p = props.get(id)!;
    if (t === 'c') {
      p.commits.delete(from);
    } else if (t === 's') {
      p.shares.delete(from);
    } else if (t === 'set' && from === p.by) {
      p.split = true;
    }
  }
  return [...props.values()];
};

/** the round-one and round-two calls, bound to this device's seat */
export interface SignCalls {
  round1(): Promise<{ nonces: string; commitments: string }>;
  sign(nonces: string, sighash: string, alpha: string, commits: string[]): Promise<string>;
  aggregate(sighash: string, alpha: string, commits: string[], shares: string[]): Promise<string>;
  /** inject the signatures into the PCZT and broadcast it; the txid */
  complete(p: Proposal, sigs: string[], cold?: string): Promise<string>;
}

const say = async (io: FrostIo, body: Parameters<typeof packFrost>[0]) =>
  io.post(await packFrost(body), `${body.t}:${body.id}`);

/**
 * "review and seal": one round-one commitment per spend, the nonces kept
 * here, with the hash of exactly the payment that was reviewed.
 */
export const seal = async (p: Reviewed, calls: SignCalls, io: FrostIo) => {
  const r: { nonces: string; commitments: string }[] = [];
  for (let i = 0; i < p.alphas.length; i++) {
    r.push(await calls.round1());
  }
  const mine = await io.keep(p.id, {
    n: r.map(x => x.nonces),
    cm: r.map(x => x.commitments),
    rv: reviewOf(p),
  });
  if (mine.rv !== reviewOf(p)) {
    throw new Error('this payment was sealed as something else. it is not signed.');
  }
  await say(io, { t: 'c', id: p.id, c: mine.cm! });
  return mine;
};

/** "decline": said in the room, and this device will not seal it */
export const decline = async (p: Pick<Proposal, 'id'>, io: FrostIo) => {
  await io.keep(p.id, { no: true });
  await say(io, { t: 'no', id: p.id });
};

/** 'refused': it is not the payment this device sealed, or its signers were named twice */
export type SignStatus = 'open' | 'signing' | 'sent' | 'idle' | 'refused';

/**
 * What a device does by itself once it sealed: the proposer names the
 * signers and, with every share, finishes; a named signer releases its
 * shares. Safe to call again at any time.
 */
export const advanceSign = async (
  p: Proposal,
  w: RoomWallet,
  mine0: FrostMine | undefined,
  me: string,
  calls: SignCalls,
  io: FrostIo,
): Promise<SignStatus> => {
  if (p.sent) {
    return 'sent';
  }
  let mine = mine0 ?? {};
  if (!mine.cm) {
    return 'idle';
  }
  // only exactly what this device reviewed, and only under one list of signers
  if (mine.rv !== reviewOf(p) || p.split) {
    return 'refused';
  }
  if (!p.commits.has(me)) {
    await say(io, { t: 'c', id: p.id, c: mine.cm });
  }
  const commits = new Map(p.commits).set(me, mine.cm);
  let set = p.set;
  if (p.by === me && mine.set && set && mine.set.join() !== set.join()) {
    return 'refused';
  }
  if (!set && p.by === me) {
    if (!mine.set) {
      const sealed = [me, ...[...commits.keys()].filter(m => m !== me)];
      if (sealed.length < w.threshold) {
        return 'open';
      }
      // kept before it is said: two windows of the proposer name one list
      mine = await io.keep(p.id, { set: sealed.slice(0, w.threshold) });
    }
    set = mine.set!;
    await say(io, { t: 'set', id: p.id, m: set });
  }
  if (!set?.includes(me)) {
    return set ? 'signing' : 'open';
  }
  const per = (i: number) => set.map(m => commits.get(m)?.[i] ?? '');
  if (set.some(m => !commits.has(m))) {
    return 'signing';
  }
  if (!mine.released && mine.n) {
    const s: string[] = [];
    for (let i = 0; i < p.alphas.length; i++) {
      s.push(await calls.sign(mine.n[i]!, p.sighash, p.alphas[i]!, per(i)));
    }
    // the shares kept are the ones said: a second window's are never posted
    mine = await io.keep(p.id, { released: true, sh: s });
    await say(io, { t: 's', id: p.id, s: mine.sh! });
  } else if (mine.sh && !p.shares.has(me)) {
    await say(io, { t: 's', id: p.id, s: mine.sh });
  }
  if (p.by !== me) {
    return 'signing';
  }
  const shares = new Map(p.shares);
  if (mine.sh) {
    shares.set(me, mine.sh);
  }
  if (!set.every(m => shares.has(m))) {
    return 'signing';
  }
  const sigs: string[] = [];
  for (let i = 0; i < p.alphas.length; i++) {
    sigs.push(
      await calls.aggregate(
        p.sighash,
        p.alphas[i]!,
        per(i),
        set.map(m => shares.get(m)![i]!),
      ),
    );
  }
  const tx = mine.tx ?? (await calls.complete(p, sigs, mine.cold));
  await io.keep(p.id, { tx });
  await say(io, { t: 'sent', id: p.id, tx });
  return 'sent';
};
