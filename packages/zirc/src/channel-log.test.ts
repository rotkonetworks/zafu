import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

import {
  appendRecord,
  channelStateAt,
  createGenesis,
  decisionView,
  genesisHash,
  recordBytes,
  recordHash,
  verifyChain,
  type ChannelBody,
  type ChannelRecord,
  type ChannelSigner,
} from './channel-log';
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

/** a channel with a founder and a couple of voiced members, built through the API. */
const setup = async () => {
  const founder = signer(1);
  const alice = signer(2);
  const bob = signer(3);
  const carol = signer(4);
  const mallory = signer(9);

  const genesis = await createGenesis({ id: 'chan-1', founder, rules });
  const records: ChannelRecord[] = [];
  const add = async (author: ChannelSigner, body: ChannelBody): Promise<ChannelRecord> => {
    const record = await appendRecord({ genesis, records, author, body });
    records.push(record);
    return record;
  };

  return { founder, alice, bob, carol, mallory, genesis, records, add };
};

describe('genesis', () => {
  it('binds the id, the founder and the rules, and the founder is the first operator', async () => {
    const { genesis, founder } = await setup();
    expect(genesis.founder).toBe(founder.pubkey);
    expect(genesisHash(genesis)).toHaveLength(64);

    const state = channelStateAt(founder.pubkey, [], 0);
    // the founder is an operator from the genesis alone; nobody is voiced yet
    expect(state.ops).toEqual([founder.pubkey]);
    expect(state.voice).toEqual([]);
  });

  it('refuses a genesis whose rules were changed after signing', async () => {
    const { genesis } = await setup();
    const tampered = { ...genesis, rules: { ...rules, windowLogs: 10_000 } };

    const check = await verifyChain({ genesis: tampered, records: [], signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('genesis signature');
  });
});

describe('verifyChain', () => {
  it('accepts a founder-written chain: voice a member, then let them vote', async () => {
    const { founder, alice, bob, genesis, records, add } = await setup();
    await add(founder, { kind: 'mode', mode: '+v', subject: alice.pubkey });
    await add(founder, { kind: 'mode', mode: '+v', subject: bob.pubkey });
    await add(alice, { kind: 'open', item: 'item-1', decision: 'hide' });
    await add(alice, { kind: 'vote', item: 'item-1', decision: 'hide' });

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check).toEqual({ ok: true });

    const state = channelStateAt(founder.pubkey, records, records.length);
    expect(state.voice).toEqual([alice.pubkey, bob.pubkey]);
    expect(state.ops).toEqual([founder.pubkey]);
  });

  it('refuses a record that would authorize itself', async () => {
    // mallory is not an operator; a `+v` for themselves must not count, and must
    // not be rescued by the record's own effect
    const { mallory, genesis, records, add } = await setup();
    await add(mallory, { kind: 'mode', mode: '+v', subject: mallory.pubkey });

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.at).toBe(1);
    expect(check.reason).toContain('was not an operator');
  });

  it('refuses a self-granted operator record', async () => {
    const { mallory, genesis, records, add } = await setup();
    await add(mallory, { kind: 'mode', mode: '+o', subject: mallory.pubkey });
    // ...and mallory cannot launder it by voicing themselves first either
    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
  });

  it('refuses an unvoiced open or vote', async () => {
    const { mallory, genesis, records, add } = await setup();
    await add(mallory, { kind: 'open', item: 'item-1', decision: 'hide' });

    const check = await verifyChain({ genesis, records, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('was not voiced');
  });

  it('refuses a record whose body was edited after signing', async () => {
    const { founder, alice, genesis, records, add } = await setup();
    await add(founder, { kind: 'mode', mode: '+v', subject: alice.pubkey });

    const tampered = {
      ...records[0]!,
      body: { kind: 'mode', mode: '-v', subject: alice.pubkey } as const,
    };
    const check = await verifyChain({ genesis, records: [tampered], signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('signature');
  });

  it('refuses a reordered or spliced record', async () => {
    const { founder, alice, bob, genesis, records, add } = await setup();
    await add(founder, { kind: 'mode', mode: '+v', subject: alice.pubkey });
    await add(founder, { kind: 'mode', mode: '+v', subject: bob.pubkey });

    const spliced = [records[1]!, records[0]!];
    const check = await verifyChain({ genesis, records: spliced, signer: verifier });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/index|chain/);
  });

  it('refuses a record from another channel replayed into this one', async () => {
    const { founder, alice, genesis, records, add } = await setup();
    await add(founder, { kind: 'mode', mode: '+v', subject: alice.pubkey });

    // a record with the same shape, signed by the founder, but for another channel
    const foreign = await appendRecord({
      genesis: { ...genesis, id: 'chan-2' },
      records,
      author: founder,
      body: { kind: 'mode', mode: '+v', subject: alice.pubkey },
    });
    const check = await verifyChain({
      genesis,
      records: [{ ...foreign, at: 2, prev: recordHash(genesis.id, records[0]!) }],
      signer: verifier,
    });
    expect(check.ok).toBe(false);
  });

  it('refuses a forged signature', async () => {
    const { founder, alice, genesis, records } = await setup();
    const bytes = recordBytes(genesis.id, 1, genesisHash(genesis), {
      kind: 'mode',
      mode: '+v',
      subject: alice.pubkey,
    });
    const forged = {
      at: 1,
      prev: genesisHash(genesis),
      author: founder.pubkey,
      body: { kind: 'mode', mode: '+v', subject: alice.pubkey } as const,
      sig: await signer(9).sign(bytes), // signed by the wrong key
    };

    const check = await verifyChain({ genesis, records: [forged], signer: verifier });
    expect(check.ok).toBe(false);
    expect(records).toEqual([]);
  });
});

describe('decisionView', () => {
  it('hides an item once the hide threshold passes, and reveals it again later', async () => {
    const { founder, alice, bob, carol, genesis, records, add } = await setup();
    await add(founder, { kind: 'mode', mode: '+v', subject: alice.pubkey });
    await add(founder, { kind: 'mode', mode: '+v', subject: bob.pubkey });
    await add(founder, { kind: 'mode', mode: '+v', subject: carol.pubkey });
    await add(alice, { kind: 'open', item: 'item-1', decision: 'hide' });
    await add(alice, { kind: 'vote', item: 'item-1', decision: 'hide' });

    const before = decisionView({ genesis, records, item: 'item-1' });
    expect(before.opened).toEqual({ at: 4, decision: 'hide' });
    expect(before.hide?.votes).toEqual([alice.pubkey]);
    expect(before.hide?.electorate).toEqual([alice.pubkey, bob.pubkey, carol.pubkey]);
    expect(before.hide?.threshold).toBe(1); // ceil(3 * 1/3)
    expect(before.hidden).toBe(true);

    // a reveal needs half of the electorate, and a later decision supersedes
    await add(bob, { kind: 'open', item: 'item-1', decision: 'reveal' });
    await add(alice, { kind: 'vote', item: 'item-1', decision: 'reveal' });
    await add(bob, { kind: 'vote', item: 'item-1', decision: 'reveal' });

    const after = decisionView({ genesis, records, item: 'item-1' });
    expect(after.opened?.decision).toBe('reveal');
    expect(after.reveal?.passed).toBe(true);
    expect(after.hidden).toBe(false);
  });

  it('says nothing about an item nobody opened', async () => {
    const { genesis, records } = await setup();
    const view = decisionView({ genesis, records, item: 'never-opened' });
    expect(view).toEqual({
      item: 'never-opened',
      opened: null,
      hide: null,
      reveal: null,
      hidden: false,
    });
  });
});
