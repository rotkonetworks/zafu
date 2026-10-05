/**
 * A payment from a shared wallet signs only what each member reviewed: a
 * payment said again under the same id, by its proposer or by anyone else,
 * is never read; a seal is bound to the reviewed payment; the signers are
 * named once, by the proposer; a signer posts the shares it kept.
 *
 * @vitest-environment node
 */

import { describe, expect, test, vi } from 'vitest';
import { decodeWire } from './door';
import {
  keepMine,
  propId,
  readBody,
  type FrostBody,
  type FrostIo,
  type FrostMine,
  type FrostMsg,
} from './frost-room';
import {
  advanceSign,
  proposalsOf,
  reviewOf,
  seal,
  type Proposal,
  type SignCalls,
} from './room-sign';

const P = '1'.repeat(64); // the proposer
const A = '2'.repeat(64); // a member who reviews and seals
const M = '3'.repeat(64); // a member who would like the money
const W = 'a'.repeat(32);
const wallet = { ceremony: W, members: [P, A, M], threshold: 2 };

type PropBody = Extract<FrostBody, { t: 'prop' }>;
const propOf = (p: Omit<PropBody, 't' | 'id'>): PropBody => ({ t: 'prop', id: propId(p), ...p });

const honest = propOf({
  w: W,
  by: P,
  to: 'u1landlord',
  amt: '10000000',
  fee: '10000',
  sighash: '4'.repeat(64),
  alphas: ['5'.repeat(64)],
  si: [0],
  pczt: 'aa',
});

let at = 100;
const msg = (from: string, body: FrostBody): FrostMsg => ({
  from,
  at: at++,
  mid: String(at),
  body,
});

/** the body a post carried, read back the way a room reads it */
const unpack = async (records: string[]): Promise<FrostBody[]> => {
  const parts = records.map(r => decodeWire(r)).filter(w => w?.kind === 'kc');
  const all = new Uint8Array(parts.reduce((n, w) => n + w!.data.length, 0));
  parts.reduce((at, w) => (all.set(w!.data, at), at + w!.data.length), 0);
  const raw = await new Response(
    new Blob([all]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
  ).text();
  const body = readBody(JSON.parse(raw));
  return body ? [body] : [];
};

/** a device's room vault and outbox */
const device = (me: string) => {
  const kept: Record<string, FrostMine> = {};
  const posted: FrostBody[] = [];
  const io: FrostIo = {
    post: async bodies => void posted.push(...(await unpack(bodies))),
    keep: async (id, patch) => (kept[id] = keepMine(kept[id], patch)),
    save: async () => undefined,
  };
  return { kept, posted, io };
};

const callsOf = (who: string): SignCalls & { sign: ReturnType<typeof vi.fn> } => ({
  round1: async () => ({ nonces: `n-${who}`, commitments: `c${who.slice(0, 1)}`.padEnd(8, '0') }),
  sign: vi.fn(async (_n, sighash: string) => `${who.slice(0, 1)}${sighash.slice(0, 7)}`),
  aggregate: async () => 'ff'.repeat(64),
  complete: async () => 'ab'.repeat(32),
});

describe('signing what was reviewed, and nothing else', () => {
  test('a payment said again under its id, with another payee, is never read', () => {
    const swapped = { ...honest, to: 'u1mallory', sighash: '6'.repeat(64) };
    const msgs = [msg(P, honest), msg(M, swapped), msg(P, swapped)];
    const [p, ...more] = proposalsOf(msgs, wallet);
    expect(more).toEqual([]);
    expect(p).toMatchObject({ id: honest.id, by: P, to: 'u1landlord', sighash: honest.sighash });
  });

  test("another member's copy of a payment does not make them its proposer", () => {
    // the same body, said by M first: M is not `by`, so it is not read as M's
    const msgs = [msg(M, honest), msg(P, honest), msg(M, { t: 'set', id: honest.id, m: [M, A] })];
    const [p] = proposalsOf(msgs, wallet);
    expect(p!.by).toBe(P);
    // and only the proposer names who signs
    expect(p!.set).toBeUndefined();
  });

  test('a replaced payment is never signed', async () => {
    const a = device(A);
    const calls = callsOf(A);
    const [reviewed] = proposalsOf([msg(P, honest)], wallet);
    await seal(reviewed!, calls, a.io);
    expect(a.kept[honest.id]!.rv).toBe(reviewOf(reviewed!));
    // what the device is later shown under that id is something else
    const other: Proposal = {
      ...reviewed!,
      to: 'u1mallory',
      sighash: '6'.repeat(64),
      commits: new Map([
        [P, ['c1000000']],
        [A, a.kept[honest.id]!.cm!],
      ]),
      set: [P, A],
    };
    expect(await advanceSign(other, wallet, a.kept[honest.id], A, calls, a.io)).toBe('refused');
    expect(calls.sign).not.toHaveBeenCalled();
    expect(a.kept[honest.id]!.n).toBeDefined();
    // the payment it did review signs as before
    const same: Proposal = { ...other, to: reviewed!.to, sighash: reviewed!.sighash };
    expect(await advanceSign(same, wallet, a.kept[honest.id], A, calls, a.io)).toBe('signing');
    expect(calls.sign).toHaveBeenCalledOnce();
    expect(calls.sign.mock.calls[0]![1]).toBe(honest.sighash);
  });

  test('a seal from before the review hash existed signs nothing', async () => {
    const a = device(A);
    const calls = callsOf(A);
    const [p] = proposalsOf(
      [
        msg(P, honest),
        msg(P, { t: 'c', id: honest.id, c: ['c1000000'] }),
        msg(P, { t: 'set', id: honest.id, m: [P, A] }),
      ],
      wallet,
    );
    const old = { n: ['n-old'], cm: ['c2000000'] };
    expect(await advanceSign(p!, wallet, old, A, calls, a.io)).toBe('refused');
    expect(calls.sign).not.toHaveBeenCalled();
  });

  test('a signer list swapped after the first is ignored, and stops the payment', async () => {
    const a = device(A);
    const calls = callsOf(A);
    const [reviewed] = proposalsOf([msg(P, honest)], wallet);
    await seal(reviewed!, calls, a.io);
    const msgs = [
      msg(P, honest),
      msg(P, { t: 'c', id: honest.id, c: ['c1000000'] }),
      msg(A, { t: 'c', id: honest.id, c: a.kept[honest.id]!.cm! }),
      msg(M, { t: 'c', id: honest.id, c: ['c3000000'] }),
      msg(P, { t: 'set', id: honest.id, m: [P, M] }),
      msg(P, { t: 'set', id: honest.id, m: [P, A] }),
    ];
    const [p] = proposalsOf(msgs, wallet);
    // the first list is the one read; a second, different one marks it split
    expect(p!.set).toEqual([P, M]);
    expect(p!.split).toBe(true);
    expect(await advanceSign(p!, wallet, a.kept[honest.id], A, calls, a.io)).toBe('refused');
    expect(calls.sign).not.toHaveBeenCalled();
  });

  test('a set from anyone but the proposer is ignored', () => {
    const msgs = [
      msg(P, honest),
      msg(M, { t: 'set', id: honest.id, m: [M, A] }),
      msg(A, { t: 'set', id: honest.id, m: [A, M] }),
    ];
    const [p] = proposalsOf(msgs, wallet);
    expect(p!.set).toBeUndefined();
    expect(p!.split).toBeUndefined();
  });

  test('a member who says two different commitments is not counted', () => {
    const msgs = [
      msg(P, honest),
      msg(M, { t: 'c', id: honest.id, c: ['c3000000'] }),
      msg(M, { t: 'c', id: honest.id, c: ['c3000001'] }),
    ];
    const [p] = proposalsOf(msgs, wallet);
    expect(p!.commits.has(M)).toBe(false);
  });

  test('a signer posts the shares it kept, never ones it made again', async () => {
    const a = device(A);
    const calls = callsOf(A);
    const [reviewed] = proposalsOf([msg(P, honest)], wallet);
    await seal(reviewed!, calls, a.io);
    const p: Proposal = {
      ...reviewed!,
      commits: new Map([
        [P, ['c1000000']],
        [A, a.kept[honest.id]!.cm!],
      ]),
      set: [P, A],
    };
    // another window of this device released its shares first
    const before = a.kept[honest.id]!;
    a.kept[honest.id] = keepMine(before, { released: true, sh: ['0f1257'] });
    const mine = { ...before };
    expect(await advanceSign(p, wallet, mine, A, calls, a.io)).toBe('signing');
    const shares = a.posted.filter(b => b.t === 's');
    expect(shares).toEqual([{ t: 's', id: honest.id, s: ['0f1257'] }]);
  });

  test('the proposer names the signers once, from what it kept', async () => {
    const pd = device(P);
    const calls = callsOf(P);
    const [reviewed] = proposalsOf([msg(P, honest)], wallet);
    await seal(reviewed!, calls, pd.io);
    const p: Proposal = {
      ...reviewed!,
      commits: new Map([
        [A, ['c2000000']],
        [M, ['c3000000']],
      ]),
    };
    await advanceSign(p, wallet, pd.kept[honest.id], P, calls, pd.io);
    expect(pd.kept[honest.id]!.set).toEqual([P, A]);
    // a second window that saw M first still says the list that was kept
    const p2: Proposal = { ...p, commits: new Map([[M, ['c3000000']]]) };
    await advanceSign(p2, wallet, pd.kept[honest.id], P, calls, pd.io);
    const sets = pd.posted.filter(b => b.t === 'set');
    expect(new Set(sets.map(b => JSON.stringify(b)))).toEqual(
      new Set([JSON.stringify({ t: 'set', id: honest.id, m: [P, A] })]),
    );
  });
});
