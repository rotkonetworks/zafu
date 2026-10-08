/**
 * The memo door end to end on a fake relay: A opens a pair room and puts its
 * secret in a memo; B's memo sync hands the memo over (the memo-ingest seam);
 * B accepts, joins, and answers with a card; A's next pass learns who
 * answered; they talk. Declining makes no request at all.
 *
 * @vitest-environment node
 */

import { describe, expect, test, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { RelayTransport } from '@zafu/zid';
import { deriveRelationshipKeys } from '../state/identity';
import { cardLinkPayload, contactCardMemoHex } from '../state/contact-share';
import type { Contact } from '../state/contacts';
import { createPeopleService, threadKey } from './service';
import { createInvites } from './invites';
import { encodeMemoInvite } from './memo-door';
import { identityOf } from './keys';
import { pairId } from './protocol';
import type { PeopleRoom, StoredInvite, Thread } from './vault';

const ALICE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BOB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const EVE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const UA_A = 'u1' + 'a'.repeat(104);
const UA_B = 'u1' + 'c'.repeat(104); // bech32 has no 'b'

const relayBoard = () => {
  const coords = new Map<string, Map<string, Uint8Array>>();
  let calls = 0;
  const transport = vi.fn(
    (): RelayTransport => ({
      putBucket: async r => {
        calls++;
        const k = `${r.appScope}|${r.epoch}|${r.shard}`;
        const c = coords.get(k) ?? new Map();
        r.entries.forEach(e => c.set(bytesToHex(e.tag), e.blob));
        coords.set(k, c);
      },
      getBucket: async r => {
        calls++;
        return [...(coords.get(`${r.appScope}|${r.epoch}|${r.shard}`)?.entries() ?? [])].map(
          ([t, b]) => ({ tag: hexToBytes(t), blob: b }),
        );
      },
    }),
  );
  return { transport, calls: () => calls };
};

const device = (
  walletId: string,
  phrase: string,
  contacts: Contact[],
  transport: () => RelayTransport,
  clock: { t: number },
) => {
  let rooms: PeopleRoom[] = [];
  let threads: Record<string, Thread> = {};
  let invites: StoredInvite[] = [];
  const inv = createInvites({
    walletId: async () => walletId,
    contacts: async () => contacts,
    roomKeys: async () => {
      throw new Error('no groups here');
    },
    generation: async () => 0,
    relay: async () => 'https://zcash.rotko.net',
    now: () => clock.t,
    read: async () => structuredClone(invites),
    write: async all => ((invites = structuredClone(all)), true),
  });
  const service = createPeopleService(
    {
      readRooms: async () => structuredClone(rooms),
      writeRooms: async r => ((rooms = structuredClone(r)), true),
      readThreads: async () => structuredClone(threads),
      writeThreads: async t => ((threads = structuredClone(t)), true),
      walletId: async () => walletId,
      identity: async room =>
        identityOf(deriveRelationshipKeys(phrase, room.signer.gen, room.signer.j!)),
      gate: async () => 'on',
      transport,
      status: () => undefined,
      now: () => clock.t,
    },
    inv.handlers,
  );
  const op = (name: string, args: Record<string, unknown> = {}) =>
    (
      inv.ops as Record<string, (r: Record<string, unknown>, s: typeof service) => Promise<unknown>>
    )[name]!(args, service);
  return {
    service,
    op,
    invites: () => invites,
    room: (id: string) => rooms.find(r => r.id === id),
    lines: (id: string) =>
      threads[threadKey({ walletId, id })]?.items.map(i => `${i.mine ? 'me' : 'them'}: ${i.body}`),
  };
};

// alice has bob saved by address only, and gave him relationship 0
const bobForAlice: Contact = {
  id: 'bob',
  name: 'bob',
  rel: { walletId: 'wa', gen: 0, j: 0 },
  createdAt: 0,
  addresses: [{ id: 'x', network: 'zcash', address: UA_B }],
};

describe('a chat invite in a memo', () => {
  test('A invites, B accepts and answers, both talk over the relay', async () => {
    const relay = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a0 = deriveRelationshipKeys(ALICE, 0, 0);
    const secret = '7e'.repeat(32);
    const alice = device('wa', ALICE, [bobForAlice], relay.transport, clock);
    await alice.op('invite-open', { contactId: 'bob', secret, relay: '' });
    expect(alice.room(pairId('bob'))?.pair).toMatchObject({ waiting: true });
    const memo = `hi bob\n${encodeMemoInvite({
      kind: 'pair',
      secret,
      inception: a0.pubkey,
      pairKa: a0.kaPublicKey,
      name: 'alice',
      address: UA_A,
      relay: '',
    })}`;

    // bob's zafu: the memo sync hands the memo over; he saves alice and accepts
    const b5 = deriveRelationshipKeys(BOB, 0, 5);
    const aliceForBob: Contact = {
      id: 'alice',
      name: 'alice',
      zid: a0.pubkey,
      pairKa: a0.kaPublicKey,
      rel: { walletId: 'wb', gen: 0, j: 5 },
      createdAt: 0,
      addresses: [{ id: 'y', network: 'zcash', address: UA_A }],
    };
    const bob = device('wb', BOB, [aliceForBob], relay.transport, clock);
    expect(await bob.op('memo-ingest', { network: 'zcash', txId: 'tx1', content: memo })).toEqual({
      stored: true,
    });
    // a second sync of the same memo is the same invite
    await bob.op('memo-ingest', { network: 'zcash', txId: 'tx1', content: memo });
    expect(bob.invites()).toHaveLength(1);
    expect(bob.invites()[0]!.read).toMatchObject({ ok: true, invite: { name: 'alice' } });
    expect(relay.calls()).toBe(0); // nothing touches a relay until he accepts

    const card = cardLinkPayload(
      contactCardMemoHex({
        senderName: 'bob',
        myAddress: UA_B,
        zid: b5.pubkey,
        pairKa: b5.kaPublicKey,
        answers: a0.pubkey,
      })!,
    );
    await bob.op('invite-accept', { id: 'tx1', contactId: 'alice', card });
    expect(bob.invites()[0]!.state).toBe('accepted');
    expect(bob.room(pairId('alice'))).toMatchObject({ secret, pair: { peer: a0.pubkey } });

    // alice's next pass reads the answer. Anyone who can read the memo could
    // have sent it, so it waits for her to say it is bob
    clock.t += 30_000;
    await alice.service.open();
    expect(alice.room(pairId('bob'))?.pair).toMatchObject({
      waiting: false,
      answers: [{ zid: b5.pubkey, pairKa: b5.kaPublicKey, address: UA_B, name: 'bob' }],
    });
    expect(alice.room(pairId('bob'))?.pair?.peer).toBeUndefined();
    await alice.op('pair-choose', { contactId: 'bob', zid: b5.pubkey });
    expect(alice.room(pairId('bob'))?.pair).toMatchObject({
      peer: b5.pubkey,
      waiting: false,
      card: { zid: b5.pubkey, pairKa: b5.kaPublicKey, address: UA_B, name: 'bob' },
    });
    expect(alice.room(pairId('bob'))?.pair?.answers).toBeUndefined();

    expect(await alice.service.say(pairId('bob'), 'final logo files are up')).toBe('sent');
    clock.t += 10_000;
    await bob.service.open();
    expect(await bob.service.say(pairId('alice'), 'looks great')).toBe('sent');
    await alice.service.check();
    expect(alice.lines(pairId('bob'))).toEqual([
      'me: final logo files are up',
      'them: looks great',
    ]);
    expect(bob.lines(pairId('alice'))).toEqual([
      'them: final logo files are up',
      'me: looks great',
    ]);
  });

  /** someone who can read the memo (a viewing key, say) answers it as themselves */
  const answerAs = async (
    phrase: string,
    walletId: string,
    j: number,
    answers: string,
    memo: string,
    relay: ReturnType<typeof relayBoard>,
    clock: { t: number },
    contact?: Contact,
  ) => {
    const keys = deriveRelationshipKeys(phrase, 0, j);
    const aliceForThem: Contact = contact ?? {
      id: 'alice',
      name: 'alice',
      rel: { walletId, gen: 0, j },
      createdAt: 0,
      addresses: [],
    };
    const them = device(walletId, phrase, [aliceForThem], relay.transport, clock);
    await them.op('memo-ingest', { network: 'zcash', txId: `tx-${walletId}`, content: memo });
    const card = cardLinkPayload(
      contactCardMemoHex({
        senderName: walletId,
        myAddress: UA_B,
        zid: keys.pubkey,
        pairKa: keys.kaPublicKey,
        answers,
      })!,
    );
    await them.op('invite-accept', { id: `tx-${walletId}`, contactId: 'alice', card });
    return keys;
  };

  const opened = async (contacts: Contact[]) => {
    const relay = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a0 = deriveRelationshipKeys(ALICE, 0, 0);
    const secret = '5a'.repeat(32);
    const alice = device('wa', ALICE, contacts, relay.transport, clock);
    await alice.op('invite-open', { contactId: 'bob', secret, relay: '' });
    const memo = encodeMemoInvite({
      kind: 'pair',
      secret,
      inception: a0.pubkey,
      pairKa: a0.kaPublicKey,
      name: 'alice',
      address: UA_A,
      relay: '',
    });
    return { relay, clock, a0, alice, memo };
  };

  test('two people answer one memo: both are shown, neither is picked', async () => {
    const { relay, clock, a0, alice, memo } = await opened([bobForAlice]);
    const eve = await answerAs(EVE, 'we', 2, a0.pubkey, memo, relay, clock);
    const bob = await answerAs(BOB, 'wb', 5, a0.pubkey, memo, relay, clock);
    clock.t += 30_000;
    await alice.service.open();
    const pair = alice.room(pairId('bob'))?.pair;
    expect(pair?.peer).toBeUndefined();
    expect(pair?.answers?.map(a => a.zid).sort()).toEqual([bob.pubkey, eve.pubkey].sort());
  });

  test('an answer to another relationship is not an answer to this invite', async () => {
    const { relay, clock, alice, memo } = await opened([bobForAlice]);
    await answerAs(EVE, 'we', 2, deriveRelationshipKeys(ALICE, 0, 7).pubkey, memo, relay, clock);
    clock.t += 30_000;
    await alice.service.open();
    expect(alice.room(pairId('bob'))?.pair?.answers).toBeUndefined();
    expect(alice.room(pairId('bob'))?.pair?.waiting).toBe(true);
  });

  test("a contact whose key you hold: their answer is them, a stranger's is not", async () => {
    const b5 = deriveRelationshipKeys(BOB, 0, 5);
    const known: Contact = { ...bobForAlice, zid: b5.pubkey };
    const { relay, clock, a0, alice, memo } = await opened([known]);
    const eve = await answerAs(EVE, 'we', 2, a0.pubkey, memo, relay, clock);
    await answerAs(BOB, 'wb', 5, a0.pubkey, memo, relay, clock);
    clock.t += 30_000;
    await alice.service.open();
    const pair = alice.room(pairId('bob'))?.pair;
    expect(pair?.peer).toBe(b5.pubkey);
    // eve's answer names a key alice never held for bob: it is not him, and
    // nothing of it reaches the room's person
    expect(pair?.card?.zid).toBe(b5.pubkey);
    expect(pair?.answers).toBeUndefined();
    expect(eve.pubkey).not.toBe(b5.pubkey);
  });

  test('no, thank you: the invite closes and nothing reaches a relay', async () => {
    const relay = relayBoard();
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const a0 = deriveRelationshipKeys(ALICE, 0, 0);
    const memo = encodeMemoInvite({
      kind: 'pair',
      secret: '7e'.repeat(32),
      inception: a0.pubkey,
      pairKa: a0.kaPublicKey,
      name: 'alice',
      address: UA_A,
      relay: 'https://relay.somewhere.example',
    });
    const bob = device('wb', BOB, [], relay.transport, clock);
    await bob.op('memo-ingest', { network: 'zcash', txId: 'tx2', content: memo });
    await bob.op('invite-decline', { id: 'tx2' });
    expect(bob.invites()[0]!.state).toBe('declined');
    expect(await bob.op('invites')).toEqual([]);
    await bob.service.open();
    expect(relay.transport).not.toHaveBeenCalled();
    expect(relay.calls()).toBe(0);
  });

  test('a code in a memo: accepting hands the door its code and relay, and opens no room by itself', async () => {
    const relay = relayBoard();
    const memo = encodeMemoInvite({
      kind: 'code',
      code: '7-fern-dusk',
      group: 'treasury',
      from: 'alice',
      relay: 'https://relay.somewhere.example',
    });
    const bob = device('wb', BOB, [], relay.transport, { t: 0 });
    await bob.op('memo-ingest', { network: 'zcash', txId: 'tx3', content: memo });
    expect(await bob.op('invite-accept', { id: 'tx3' })).toEqual({
      code: '7-fern-dusk',
      relay: 'https://relay.somewhere.example',
    });
    expect(bob.invites()[0]!.state).toBe('accepted');
    expect(relay.calls()).toBe(0);
  });

  test('a memo with no invite, or one this zafu cannot read, is kept as such', async () => {
    const bob = device('wb', BOB, [], relayBoard().transport, { t: 0 });
    expect(await bob.op('memo-ingest', { txId: 'n', content: 'just a memo' })).toEqual({
      stored: false,
    });
    await bob.op('memo-ingest', { txId: 'v2', content: 'zafu:m1/AgAAAAAAAAAAAAAA' });
    expect(bob.invites()[0]!.read).toEqual({ ok: false, reason: 'version' });
  });
});
