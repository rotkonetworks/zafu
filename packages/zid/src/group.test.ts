import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

import {
  createGroupSession,
  decodeGroupEnvelope,
  encodeGroupEnvelope,
  signedBytes,
  type GroupEnvelope,
  type GroupMember,
  type GroupSession,
} from './group';

/** a member whose keys are real ed25519, so the signature path is genuinely exercised. */
const member = (seed: number): GroupMember & { seed32: Uint8Array } => {
  const seed32 = new Uint8Array(32).fill(seed);
  const pubkey = bytesToHex(ed25519.getPublicKey(seed32));
  return {
    seed32,
    pubkey,
    sign: async (bytes: Uint8Array): Promise<string> => bytesToHex(ed25519.sign(bytes, seed32)),
    verify: async (bytes: Uint8Array, sig: string, pub: string): Promise<boolean> => {
      try {
        return ed25519.verify(
          Uint8Array.from(sig.match(/../g) ?? [], h => parseInt(h, 16)),
          bytes,
          Uint8Array.from(pub.match(/../g) ?? [], h => parseInt(h, 16)),
        );
      } catch {
        return false;
      }
    },
  };
};

/** pairwise transport double: delivery only works between two members. */
class Bus {
  private readonly inboxes = new Map<string, (from: string, bytes: Uint8Array) => void>();
  readonly deliveries: { to: string; bytes: Uint8Array }[] = [];

  subscribe = (who: string, handler: (from: string, bytes: Uint8Array) => void): (() => void) => {
    this.inboxes.set(who.toLowerCase(), handler);
    return () => this.inboxes.delete(who.toLowerCase());
  };

  deliverFrom =
    (from: string) =>
    (to: string, bytes: Uint8Array): void => {
      this.deliveries.push({ to, bytes });
      this.inboxes.get(to.toLowerCase())?.(from, bytes);
    };

  /** inject bytes as if a given peer had sent them - for forgery/replay tests. */
  inject = (from: string, to: string, bytes: Uint8Array): void => {
    this.inboxes.get(to.toLowerCase())?.(from, bytes);
  };
}

const sessionFor = (
  bus: Bus,
  me: GroupMember,
  roster: readonly string[],
  id = 'ceremony-1',
): GroupSession =>
  createGroupSession({
    id,
    me,
    members: roster,
    deliver: bus.deliverFrom(me.pubkey),
    subscribe: handler => bus.subscribe(me.pubkey, handler),
  });

describe('group session - a coordination round', () => {
  it('fans out to every other member and completes a round', async () => {
    const bus = new Bus();
    const a = member(1);
    const b = member(2);
    const c = member(3);
    const roster = [a.pubkey, b.pubkey, c.pubkey];

    const sa = sessionFor(bus, a, roster);
    const sb = sessionFor(bus, b, roster);
    const sc = sessionFor(bus, c, roster);

    const round = 1;
    const payload = new TextEncoder().encode('commitment:' + a.pubkey.slice(0, 8));
    await sa.send(payload, round);
    await sb.send(new TextEncoder().encode('commitment:b'), round);
    await sc.send(new TextEncoder().encode('commitment:c'), round);

    // each waits for the round to complete: everyone but itself
    const atB = await sb.awaitRound(round, { timeoutMs: 200 });
    expect(atB.map(e => e.from).sort()).toEqual([a.pubkey, c.pubkey].sort());
    expect(new TextDecoder().decode(atB.find(e => e.from === a.pubkey)!.payload)).toBe(
      new TextDecoder().decode(payload),
    );

    // a member never accepts its own message back into its round
    expect(sa.received(round).map(e => e.from)).not.toContain(a.pubkey);
    expect(sa.status(round).missing).toEqual([]);

    // fan-out is one copy per peer, never a broadcast primitive
    const toC = bus.deliveries.filter(d => d.to === c.pubkey);
    expect(toC.length).toBeGreaterThan(0);
    expect(bus.deliveries.some(d => d.to === b.pubkey)).toBe(true);
  });

  it('names who is missing when a round does not complete', async () => {
    const bus = new Bus();
    const a = member(1);
    const b = member(2);
    const c = member(3);
    const roster = [a.pubkey, b.pubkey, c.pubkey];

    const sa = sessionFor(bus, a, roster);
    const sb = sessionFor(bus, b, roster);
    sessionFor(bus, c, roster); // connected, but never speaks

    await sa.send(new TextEncoder().encode('round-1'), 1);
    await sb.send(new TextEncoder().encode('round-1'), 1);

    await expect(sa.awaitRound(1, { timeoutMs: 50 })).rejects.toThrow(
      new RegExp(`missing ${c.pubkey}`),
    );
    expect(sa.status(1).missing).toEqual([c.pubkey]);
  });

  it('rejects a message from someone who is not on the roster', async () => {
    const bus = new Bus();
    const a = member(1);
    const b = member(2);
    const mallory = member(9);
    const roster = [a.pubkey, b.pubkey];

    const sb = sessionFor(bus, b, roster);
    const seen: GroupEnvelope[] = [];
    sb.onMessage(e => seen.push(e));

    // mallory signs correctly, but is not a member
    const payload = new TextEncoder().encode('not-a-member');
    const sig = await mallory.sign(signedBytes('ceremony-1', 1, mallory.pubkey, payload));
    bus.inject(
      mallory.pubkey,
      b.pubkey,
      encodeGroupEnvelope({
        group: 'ceremony-1',
        round: 1,
        from: mallory.pubkey,
        payload,
        sig,
      }),
    );

    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(sb.received(1)).toEqual([]);
  });

  it('rejects a tampered payload and a replayed message', async () => {
    const bus = new Bus();
    const a = member(1);
    const b = member(2);
    const roster = [a.pubkey, b.pubkey];

    const sa = sessionFor(bus, a, roster);
    const sb = sessionFor(bus, b, roster);

    const payload = new TextEncoder().encode('share-1');
    const sig = await a.sign(signedBytes('ceremony-1', 1, a.pubkey, payload));

    // tampered: same signature, different payload
    bus.inject(
      a.pubkey,
      b.pubkey,
      encodeGroupEnvelope({
        group: 'ceremony-1',
        round: 1,
        from: a.pubkey,
        payload: new TextEncoder().encode('share-1-evil'),
        sig,
      }),
    );
    await Promise.resolve();
    expect(sb.received(1)).toEqual([]);

    // honest, then replayed: accepted once
    const good = encodeGroupEnvelope({
      group: 'ceremony-1',
      round: 1,
      from: a.pubkey,
      payload,
      sig,
    });
    bus.inject(a.pubkey, b.pubkey, good);
    await Promise.resolve();
    await Promise.resolve();
    bus.inject(a.pubkey, b.pubkey, good);
    await Promise.resolve();

    expect(sb.received(1)).toHaveLength(1);
    void sa;
  });

  it('ignores envelopes addressed to another group', async () => {
    const bus = new Bus();
    const a = member(1);
    const b = member(2);
    const roster = [a.pubkey, b.pubkey];

    const sb = sessionFor(bus, b, roster, 'ceremony-1');
    const other = sessionFor(bus, a, roster, 'ceremony-2');
    await other.send(new TextEncoder().encode('other ceremony'), 1);

    await Promise.resolve();
    expect(sb.received(1)).toEqual([]);
  });

  it('round-trips the wire encoding and refuses malformed bytes', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const wire = encodeGroupEnvelope({
      group: 'g',
      round: 7,
      from: 'ab'.repeat(32),
      payload,
      sig: 'cd'.repeat(64),
    });
    expect(decodeGroupEnvelope(wire)).toEqual({
      group: 'g',
      round: 7,
      from: 'ab'.repeat(32),
      payload,
      sig: 'cd'.repeat(64),
    });

    expect(decodeGroupEnvelope(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeGroupEnvelope(new TextEncoder().encode('{"group":"g"}'))).toBeNull();
    expect(
      decodeGroupEnvelope(
        new TextEncoder().encode('{"group":"g","round":1,"from":"a","payload":"!!","sig":"s"}'),
      ),
    ).toBeNull();
  });
});
