import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

import {
  appendRecord,
  createGenesis,
  verifyChain,
  type ChannelBody,
  type ChannelRecord,
  type ChannelSigner,
} from './channel-log';
import { custodyBodyBytes, custodyProblems, custodyStateAt, type CustodyProposal } from './custody';
import { DEFAULT_RULES } from './vote';

/** a signer with real keys, so signatures are genuinely checked. */
const signer = (seed: number): ChannelSigner => {
  const seed32 = new Uint8Array(32).fill(seed);
  return {
    pubkey: bytesToHex(ed25519.getPublicKey(seed32)),
    sign: async (bytes: Uint8Array): Promise<string> => bytesToHex(ed25519.sign(bytes, seed32)),
  };
};

const verifier = {
  verify: async (bytes: Uint8Array, sig: string, pubkey: string): Promise<boolean> => {
    try {
      return ed25519.verify(
        Uint8Array.from(sig.match(/../g) ?? [], h => parseInt(h, 16)),
        bytes,
        Uint8Array.from(pubkey.match(/../g) ?? [], h => parseInt(h, 16)),
      );
    } catch {
      return false;
    }
  },
};

const rules = { ...DEFAULT_RULES, minElectorate: 3, windowLogs: 100 };

/** a channel with a founder and three voiced members, built through the API. */
const setup = async () => {
  const founder = signer(1);
  const alice = signer(2);
  const bob = signer(3);
  const carol = signer(4);
  const dave = signer(5);
  const mallory = signer(9);

  const genesis = await createGenesis({ id: 'chan-1', founder, rules });
  const records: ChannelRecord[] = [];
  const add = async (author: ChannelSigner, body: ChannelBody): Promise<ChannelRecord> => {
    const record = await appendRecord({ genesis, records, author, body });
    records.push(record);
    return record;
  };
  // A custody record is authorized like a vote, so its author has to be voiced.
  // The founder is an operator from the genesis alone, but an operator is not voiced,
  // so a channel whose founder is to write rosters voices them first - exactly the
  // bootstrap a chain needs before its founder can vote.
  await add(founder, { kind: 'mode', mode: '+v', subject: founder.pubkey });
  for (const member of [alice, bob, carol]) {
    await add(founder, { kind: 'mode', mode: '+v', subject: member.pubkey });
  }

  return { founder, alice, bob, carol, dave, mallory, genesis, records, add };
};

const roster = (...ed25519Keys: string[]) => ed25519Keys.map(ed25519 => ({ ed25519 }));

const proposal = (over: Partial<CustodyProposal> = {}): CustodyProposal => ({
  scheme: 'frost',
  threshold: 2,
  epoch: 1,
  fingerprint: 'aabbccdd',
  roster: roster('ab'.repeat(32), 'cd'.repeat(32), 'ef'.repeat(32)),
  ...over,
});

describe('custodyBodyBytes', () => {
  it('hashes the same bytes for the one spelling of a key', () => {
    // hex has case; a key does not. Two clients that list the same members have to
    // sign the same bytes, or a roster that verifies for one is a forgery for the other.
    const lower = proposal();
    const shouty = proposal({
      scheme: 'FROST',
      fingerprint: 'AABBCCDD',
      roster: roster('AB'.repeat(32), 'CD'.repeat(32), 'EF'.repeat(32)),
    });

    expect(custodyBodyBytes({ kind: 'custody', ...lower })).toEqual(
      custodyBodyBytes({ kind: 'custody', ...shouty }),
    );
  });

  it('separates rosters that differ in what a ceremony runs', () => {
    const base = custodyBodyBytes({ kind: 'custody', ...proposal() });
    const otherThreshold = custodyBodyBytes({
      kind: 'custody',
      ...proposal({ threshold: 1 }),
    });
    const otherMember = custodyBodyBytes({
      kind: 'custody',
      ...proposal({ roster: roster('ab'.repeat(32), 'cd'.repeat(32), '12'.repeat(32)) }),
    });

    expect(base).not.toEqual(otherThreshold);
    expect(base).not.toEqual(otherMember);
  });
});

describe('custodyProblems', () => {
  it('accepts the shape a ceremony actually produces', () => {
    expect(custodyProblems(proposal())).toEqual([]);
  });

  it('names every way a roster is not runnable', () => {
    expect(custodyProblems(proposal({ scheme: 'F' }))[0]).toContain('is not a scheme name');
    expect(custodyProblems(proposal({ fingerprint: 'AABB' }))[0]).toContain('a fingerprint is');
    expect(
      custodyProblems(proposal({ fingerprint: 'aabbccddeeff0011'.toUpperCase() }))[0],
    ).toContain('a fingerprint is');
    expect(custodyProblems(proposal({ epoch: 0 }))[0]).toContain('an epoch is an integer');
    expect(custodyProblems(proposal({ roster: [] }))[0]).toContain('at least one member');
    expect(custodyProblems(proposal({ threshold: 4 }))[0]).toBe(
      'a threshold of 4 is not between 1 and 3',
    );
  });

  it('refuses a roster that lists one identity twice, or an identity that is not hex', () => {
    const doubled = proposal({
      roster: roster('ab'.repeat(32), 'ab'.repeat(32), 'cd'.repeat(32)),
    });
    expect(custodyProblems(doubled)).toContain(`${'ab'.repeat(32)} is listed twice`);

    const notHex = proposal({ roster: roster(`zz${'ab'.repeat(31)}`, 'cd'.repeat(32)) });
    expect(custodyProblems(notHex)[0]).toContain('is not a 64-character hex identity');
  });
});

describe('custodyStateAt', () => {
  it('is empty until a roster is written, and reports the newest one after that', async () => {
    const { founder, alice, bob, records, add } = await setup();
    expect(custodyStateAt(records, records.length)).toMatchObject({
      roster: null,
      threshold: null,
      at: null,
      history: [],
    });

    const first = await add(founder, {
      kind: 'custody',
      scheme: 'frost',
      threshold: 2,
      epoch: 1,
      fingerprint: 'aabbccdd',
      roster: roster(alice.pubkey, bob.pubkey),
    });

    const state = custodyStateAt(records, records.length);
    expect(state).toMatchObject({
      threshold: 2,
      scheme: 'frost',
      epoch: 1,
      fingerprint: 'aabbccdd',
      at: first.at,
      by: founder.pubkey,
    });
    expect(state.roster?.map(m => m.ed25519)).toEqual([alice.pubkey, bob.pubkey]);
    expect(state.history.map(event => event.added)).toEqual([[alice.pubkey, bob.pubkey]]);

    // as of before the record, the multisig does not exist yet
    expect(custodyStateAt(records, first.at - 1).roster).toBeNull();
  });

  it('answers "did a custodian leave?" mechanically on a rotation', async () => {
    const { founder, alice, bob, carol, dave, records, add } = await setup();
    await add(founder, {
      kind: 'custody',
      scheme: 'frost',
      threshold: 2,
      epoch: 1,
      fingerprint: 'aabbccdd',
      roster: roster(alice.pubkey, bob.pubkey, carol.pubkey),
    });
    await add(founder, {
      kind: 'custody',
      scheme: 'frost',
      threshold: 2,
      epoch: 2,
      fingerprint: '11223344',
      roster: roster(alice.pubkey, bob.pubkey, dave.pubkey),
    });

    const state = custodyStateAt(records, records.length);
    expect(state.epoch).toBe(2);
    expect(state.fingerprint).toBe('11223344');
    expect(state.roster?.map(m => m.ed25519)).toEqual([alice.pubkey, bob.pubkey, dave.pubkey]);
    expect(state.history.map(event => event.removed)).toEqual([[], [carol.pubkey]]);
    expect(state.history.map(event => event.added)).toEqual([
      [alice.pubkey, bob.pubkey, carol.pubkey],
      [dave.pubkey],
    ]);
  });
});

describe('verifyChain over a custody record', () => {
  const custody = (rosterKeys: string[], over: Partial<CustodyProposal> = {}): ChannelBody => ({
    kind: 'custody',
    ...proposal({ roster: roster(...rosterKeys), ...over }),
  });

  it('accepts a roster a voiced member wrote, and a later rotation', async () => {
    const { founder, alice, bob, carol, dave, genesis, records, add } = await setup();
    await add(founder, custody([alice.pubkey, bob.pubkey, carol.pubkey]));
    await add(founder, custody([alice.pubkey, bob.pubkey, dave.pubkey], { epoch: 2 }));

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(true);
  });

  it('refuses a roster written by a member who was never voiced', async () => {
    const { mallory, alice, bob, genesis, records, add } = await setup();
    await add(mallory, custody([alice.pubkey, bob.pubkey]));

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('was not voiced when this custody record was written');
  });

  it('does not take an operator for an electorate: the founder is not voiced at genesis', async () => {
    // the same rule a vote follows. A channel that wants its founder writing rosters
    // voices them first; until then, an operator can grant voice but cannot use it.
    const founder = signer(1);
    const alice = signer(2);
    const bare = await createGenesis({ id: 'chan-bare', founder, rules });
    const chain: ChannelRecord[] = [];
    chain.push(
      await appendRecord({
        genesis: bare,
        records: chain,
        author: founder,
        body: custody([alice.pubkey], { threshold: 1 }),
      }),
    );

    const check = await verifyChain({ genesis: bare, records: chain, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain(`${founder.pubkey} was not voiced`);
  });

  it('refuses a roster a ceremony could not run, so it is never replayed as the multisig', async () => {
    const { founder, alice, genesis, records, add } = await setup();
    // one member, threshold 3
    await add(founder, custody([alice.pubkey], { threshold: 3 }));

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe(
      'the custody roster is not runnable: a threshold of 3 is not between 1 and 1',
    );
  });

  it('refuses an epoch that does not advance, so an old roster cannot roll a multisig back', async () => {
    const { founder, alice, bob, carol, dave, genesis, records, add } = await setup();
    await add(founder, custody([alice.pubkey, bob.pubkey, carol.pubkey], { epoch: 2 }));
    await add(founder, custody([alice.pubkey, bob.pubkey, dave.pubkey], { epoch: 2 }));

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('custody epoch 2 does not advance past 2');
  });

  it('refuses a roster that names one identity twice', async () => {
    const { founder, alice, bob, genesis, records, add } = await setup();
    await add(founder, custody([alice.pubkey, bob.pubkey, alice.pubkey]));

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain(`${alice.pubkey} is listed twice`);
  });
});
