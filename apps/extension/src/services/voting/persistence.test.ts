/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { Key } from '@repo/encryption/key';
import {
  deleteVoteCast,
  loadVoteCast,
  loadVotingRoundRecord,
  purgeVotingRound,
  saveDelegationState,
  saveVoteCast,
  saveVotingHotkey,
  VoteCastExists,
} from './persistence';

const storages = async () => {
  const { key } = await Key.create('pw');
  const keyJson = await key.toJson();
  const mem = new Map<string, unknown>();
  const local = {
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: unknown) => void mem.set(k, v),
  } as never;
  const session = {
    get: async (k: string) => (k === 'passwordKey' ? keyJson : undefined),
  } as never;
  return { mem, local, session };
};

const cast = {
  proposalId: 37,
  wire: '{"vote_commitment":"V0NPTU1JVA=="}',
  commitmentBundleJson: '{"vote_decision":1,"share_secrets":"s3cr3t"}',
  nextDelegationStateJson: '{"proposal_authority":1}',
  txHash: 'AB'.repeat(32),
};

describe('sealed vote casts', () => {
  test('nothing about the vote is readable at rest', async () => {
    const { mem, local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast);
    const raw = JSON.stringify(mem.get('votingCasts'));
    for (const plain of ['s3cr3t', 'vote_decision', cast.txHash, 'V0NPTU1JVA']) {
      expect(raw).not.toContain(plain);
    }
    expect(await loadVoteCast(local, session, 'w', 'r', 37)).toEqual(cast);
  });

  test('the storage key is a hash: it names no wallet, round or proposal', async () => {
    const { mem, local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast);
    await saveVoteCast(local, session, 'w', 'r', { ...cast, proposalId: 17 });
    const keys = Object.keys(mem.get('votingCasts') as Record<string, string>);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a box moved to another wallet or round is refused', async () => {
    const { mem, local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast);
    const [box] = Object.values(mem.get('votingCasts') as Record<string, string>);
    await saveVoteCast(local, session, 'x', 'r', { ...cast, proposalId: 5 });
    const casts = mem.get('votingCasts') as Record<string, string>;
    for (const k of Object.keys(casts)) casts[k] = box!;
    await expect(loadVoteCast(local, session, 'x', 'r', 37)).rejects.toThrow(/mismatch/);
  });

  test('create refuses to overwrite a stored cast', async () => {
    const { local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast, { create: true });
    await expect(
      saveVoteCast(local, session, 'w', 'r', { ...cast, wire: '{}' }, { create: true }),
    ).rejects.toBeInstanceOf(VoteCastExists);
    expect((await loadVoteCast(local, session, 'w', 'r', 37))!.wire).toBe(cast.wire);
  });

  test('concurrent saves under the lock keep every cast', async () => {
    const { local, session } = await storages();
    await Promise.all(
      [1, 2, 3, 4, 5].map(p => saveVoteCast(local, session, 'w', 'r', { ...cast, proposalId: p })),
    );
    for (const p of [1, 2, 3, 4, 5]) {
      expect(await loadVoteCast(local, session, 'w', 'r', p)).not.toBeNull();
    }
  });

  test('delete and the round purge drop it', async () => {
    const { local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast);
    await saveVoteCast(local, session, 'w', 'r', { ...cast, proposalId: 17 });
    await deleteVoteCast(local, session, 'w', 'r', 37);
    expect(await loadVoteCast(local, session, 'w', 'r', 37)).toBeNull();
    await purgeVotingRound(local, 'w', 'r');
    expect(await loadVoteCast(local, session, 'w', 'r', 17)).toBeNull();
  });
});

describe('sealed voting hotkeys', () => {
  test('storage shows neither the wallet, the round, the time nor the pubkey', async () => {
    const { mem, local, session } = await storages();
    await saveVotingHotkey(local, session, 'wallet-1', 'round-9', 'hot-secret', 'pub-key-hex');
    await saveDelegationState(local, session, 'wallet-1', 'round-9', '{"van":1}');
    const stored = mem.get('votingHotkeys') as Record<string, string>;
    const keys = Object.keys(stored);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(stored);
    for (const plain of ['wallet-1', 'round-9', 'hot-secret', 'pub-key-hex', 'van', 'createdAt']) {
      expect(raw).not.toContain(plain);
    }
    expect(await loadVotingRoundRecord(local, session, 'wallet-1', 'round-9')).toMatchObject({
      hotkeySecretHex: 'hot-secret',
      hotkeyPubkeyHex: 'pub-key-hex',
      delegationStateJson: '{"van":1}',
    });
  });

  test('delegation state before the hotkey is refused; a moved box is refused', async () => {
    const { mem, local, session } = await storages();
    await expect(saveDelegationState(local, session, 'w', 'r', '{}')).rejects.toThrow(/before/);
    await saveVotingHotkey(local, session, 'w', 'r', 's', 'p');
    const stored = mem.get('votingHotkeys') as Record<string, string>;
    const [box] = Object.values(stored);
    await saveVotingHotkey(local, session, 'x', 'r', 's2', 'p2');
    const all = mem.get('votingHotkeys') as Record<string, string>;
    const other = Object.keys(all).find(k => all[k] !== box)!;
    all[other] = box!;
    await expect(loadVotingRoundRecord(local, session, 'x', 'r')).rejects.toThrow(/mismatch/);
  });

  test('a record stored in the clear by an older build is read, then resealed on the next write', async () => {
    const { mem, local, session } = await storages();
    const key = await Key.fromJson(
      (await (session as { get: (k: string) => Promise<unknown> }).get('passwordKey')) as never,
    );
    const seal = async (o: unknown) => JSON.stringify((await key.seal(JSON.stringify(o))).toJson());
    mem.set('votingHotkeys', {
      'w:r': {
        roundId: 'r',
        walletId: 'w',
        hotkeySecretBox: await seal({ v: 1, walletId: 'w', roundId: 'r', secret: 'old-secret' }),
        hotkeyPubkeyHex: 'old-pub',
        delegationStateBox: null,
        createdAt: 1_700_000_000_000,
      },
    });
    expect(await loadVotingRoundRecord(local, session, 'w', 'r')).toMatchObject({
      hotkeySecretHex: 'old-secret',
      createdAt: 1_700_000_000_000,
    });
    await saveDelegationState(local, session, 'w', 'r', '{"s":1}');
    const stored = mem.get('votingHotkeys') as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(await loadVotingRoundRecord(local, session, 'w', 'r')).toMatchObject({
      hotkeySecretHex: 'old-secret',
      hotkeyPubkeyHex: 'old-pub',
      delegationStateJson: '{"s":1}',
      createdAt: 1_700_000_000_000,
    });
    await purgeVotingRound(local, 'w', 'r');
    expect(mem.get('votingHotkeys')).toEqual({});
  });
});
