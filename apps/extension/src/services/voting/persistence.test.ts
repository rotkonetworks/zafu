/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { Key } from '@repo/encryption/key';
import { deleteVoteCast, loadVoteCast, purgeVotingRound, saveVoteCast } from './persistence';

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

  test('a box moved to another wallet, round or proposal is refused', async () => {
    const { mem, local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast);
    const casts = mem.get('votingCasts') as Record<string, string>;
    mem.set('votingCasts', { 'w:r:17': casts['w:r:37'], 'x:r:37': casts['w:r:37'] });
    await expect(loadVoteCast(local, session, 'w', 'r', 17)).rejects.toThrow(/mismatch/);
    await expect(loadVoteCast(local, session, 'x', 'r', 37)).rejects.toThrow(/mismatch/);
  });

  test('delete and the round purge drop it', async () => {
    const { local, session } = await storages();
    await saveVoteCast(local, session, 'w', 'r', cast);
    await saveVoteCast(local, session, 'w', 'r', { ...cast, proposalId: 17 });
    await deleteVoteCast(local, 'w', 'r', 37);
    expect(await loadVoteCast(local, session, 'w', 'r', 37)).toBeNull();
    await purgeVotingRound(local, 'w', 'r');
    expect(await loadVoteCast(local, session, 'w', 'r', 17)).toBeNull();
  });
});
