/**
 * One hot vote, from proof to helper shares.
 *
 *   1. refuse if a vote on this proposal is already stored: that record is
 *      resumed (resumeCast), never overwritten
 *   2. ZKP #2 + signed cast in the worker (cast_vote_hot_wire)
 *   3. seal the recovery bundle, the wire and the next delegation state
 *      BEFORE anything is sent, so a crash or a lost answer can resume
 *   4. POST /cast-vote; keep the tx hash
 *   5. wait for inclusion, read the vote commitment's tree position from
 *      the tx (checked against the tree's leaves). castPosition polls for
 *      about two minutes; a cast still pending after that stays sealed for
 *      resumeCast, which a scheduler outside the popup should drive once a
 *      cast UI exists
 *   6. store the next delegation state: until the cast is on chain, the old
 *      one is still the valid one
 *   7. build the helper shares from the bundle at that position (no proof
 *      reruns, so they match the commitment on chain) and send each missing
 *      one, one share per request
 *
 * A refusal is never taken from one operator alone (confirmRefusal): the
 * record is kept, marked refused, until a second independent operator
 * agrees. Only then is it deleted.
 *
 * The bundle can rebuild shares that carry the vote's choice. It exists in
 * memory here and in sealed storage, never in plain chrome.storage.
 */

import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import {
  buildVoteSharesFromRecoveryInWorker,
  castVoteHotInWorker,
} from '../../state/keyring/network-worker';
import {
  castPosition,
  castVote,
  confirmRefusal,
  roundParamsJson,
  submitShares,
  type CastPosition,
  type RoundParams,
  type VoteTxResult,
} from './api';
import {
  deleteVoteCast,
  loadVoteCast,
  saveDelegationState,
  saveVoteCast,
  VoteCastExists,
  type VoteCastRecord,
} from './persistence';
import type { VotingServiceConfig } from './types';

const CAST_PATH = '/shielded-vote/v1/cast-vote';

export interface CastDeps {
  config: VotingServiceConfig;
  local: ExtensionStorage<LocalStorageState>;
  session: ExtensionStorage<SessionStorageState>;
}

export type CastOutcome =
  /** a vote on this proposal is already stored; resume it, nothing was built */
  | { state: 'exists'; message: string }
  /**
   * refused. `confirmed`: two independent operators agree, nothing was spent
   * and the record is gone. Otherwise the record is kept, marked refused, and
   * resumeCast asks again.
   */
  | { state: 'refused'; confirmed: boolean; message: string }
  /** it may have landed: resumeCast settles it */
  | { state: 'unknown'; message: string; txHash?: string }
  /** on chain; `queued` of the `total` shares are with a helper */
  | {
      state: 'cast';
      txHash: string;
      position: CastPosition;
      total: number;
      queued: number;
      errors: string[];
    };

interface Ids {
  walletId: string;
  roundId: string;
}

/**
 * A refusal from one operator: get a second opinion. A confirmed refusal
 * deletes the record; anything short of that keeps it, marked refused.
 * An acceptance elsewhere hands back the tx hash (`accepted`) to carry on with.
 */
const settleRefusal = async (
  deps: CastDeps,
  ids: Ids,
  record: VoteCastRecord,
  res: VoteTxResult,
): Promise<CastOutcome | { accepted: string }> => {
  const { config, local, session } = deps;
  const refusedBy = [
    ...new Set([...(record.refused?.operators ?? []), ...(res.operator ? [res.operator] : [])]),
  ];
  const second = await confirmRefusal(config, CAST_PATH, record.wire, res, refusedBy);
  if (second.ok && second.txHash) {
    return { accepted: second.txHash };
  }
  if (second.rejected && second.confirmed) {
    await deleteVoteCast(local, session, ids.walletId, ids.roundId, record.proposalId);
    return { state: 'refused', confirmed: true, message: second.message };
  }
  const operators = [
    ...new Set([...refusedBy, ...(second.rejected && second.operator ? [second.operator] : [])]),
  ];
  await saveVoteCast(local, session, ids.walletId, ids.roundId, {
    ...record,
    txHash: record.txHash ?? res.txHash,
    refused: { message: res.message, operators },
  });
  return { state: 'refused', confirmed: false, message: res.message };
};

/**
 * From an accepted cast with a tx hash to queued shares and stored state.
 * Steps a previous run already finished are not redone: a known position is
 * not looked up again, and shares a helper already queued are not re-sent.
 */
const finish = async (
  deps: CastDeps,
  ids: Ids,
  stored: VoteCastRecord & { txHash: string },
  submitAt: number,
): Promise<CastOutcome> => {
  const { config, local, session } = deps;
  const { refused: _, ...accepted } = stored;
  let record: VoteCastRecord & { txHash: string } = {
    ...accepted,
    submitAt: stored.submitAt ?? submitAt,
  };
  await saveVoteCast(local, session, ids.walletId, ids.roundId, record);
  if (!record.position) {
    const voteCommitment = (JSON.parse(record.wire) as { vote_commitment: string }).vote_commitment;
    const position = await castPosition(config, ids.roundId, record.txHash, voteCommitment);
    // On chain: the next state is now the valid one for this bundle's next cast.
    await saveDelegationState(
      local,
      session,
      ids.walletId,
      ids.roundId,
      record.nextDelegationStateJson,
    );
    record = { ...record, position };
    await saveVoteCast(local, session, ids.walletId, ids.roundId, record);
  }
  const position = record.position!;
  if (record.sharesQueued) {
    const n = record.sharesSent?.length ?? 0;
    return { state: 'cast', txHash: record.txHash, position, total: n, queued: n, errors: [] };
  }
  const { sharesJson } = await buildVoteSharesFromRecoveryInWorker({
    commitmentBundleJson: record.commitmentBundleJson,
    vcTreePosition: position.vcPosition,
    // the time fixed with the first build: a changed submit_at is a helper conflict
    submitAt: record.submitAt!,
  });
  const sent = await submitShares(config, sharesJson, { skip: record.sharesSent ?? [] });
  record = {
    ...record,
    sharesSent: sent.queued,
    sharesQueued: sent.queued.length === sent.total,
  };
  await saveVoteCast(local, session, ids.walletId, ids.roundId, record);
  return {
    state: 'cast',
    txHash: record.txHash,
    position,
    total: sent.total,
    queued: sent.queued.length,
    errors: sent.errors,
  };
};

/** Carry a POST answer on: finish, keep it unknown, or settle a refusal. */
const afterPost = async (
  deps: CastDeps,
  ids: Ids,
  record: VoteCastRecord,
  res: VoteTxResult,
  submitAt: number,
): Promise<CastOutcome> => {
  let txHash = res.ok ? res.txHash : undefined;
  if (res.rejected) {
    const settled = await settleRefusal(deps, ids, record, res);
    if (!('accepted' in settled)) {
      return settled;
    }
    txHash = settled.accepted;
  }
  if (!txHash) {
    if (res.txHash) {
      await saveVoteCast(deps.local, deps.session, ids.walletId, ids.roundId, {
        ...record,
        txHash: res.txHash,
      });
    }
    return { state: 'unknown', message: res.message, txHash: res.txHash };
  }
  return finish(deps, ids, { ...record, txHash }, submitAt);
};

/** Cast one vote and hand its shares out (see the module comment). */
export const castAndShare = async (
  deps: CastDeps,
  a: {
    walletId: string;
    network: string;
    round: RoundParams;
    hotkeySecretHex: string;
    delegationStateJson: string;
    vanWitnessJson: string;
    proposalId: number;
    choice: number;
    numOptions: number;
    /** unix seconds the helpers should reveal at; 0 = right away */
    submitAt: number;
  },
): Promise<CastOutcome> => {
  const { config, local, session } = deps;
  const ids = { walletId: a.walletId, roundId: a.round.voteRoundId };
  const exists = (): CastOutcome => ({
    state: 'exists',
    message: new VoteCastExists(a.proposalId).message,
  });
  if (await loadVoteCast(local, session, ids.walletId, ids.roundId, a.proposalId)) {
    return exists();
  }
  const built = await castVoteHotInWorker({
    network: a.network,
    hotkeySecretHex: a.hotkeySecretHex,
    roundParamsJson: roundParamsJson(a.round),
    delegationStateJson: a.delegationStateJson,
    vanWitnessJson: a.vanWitnessJson,
    // vc_tree_position is unknown until inclusion; shares are built after it
    voteJson: JSON.stringify({
      proposal_id: a.proposalId,
      choice: a.choice,
      num_options: a.numOptions,
      vc_tree_position: 0,
      single_share: false,
    }),
  });
  const record: VoteCastRecord = {
    proposalId: built.proposalId,
    wire: built.wire,
    commitmentBundleJson: built.commitmentBundleJson,
    nextDelegationStateJson: built.nextDelegationStateJson,
  };
  try {
    // insert-only under the casts lock: a record that appeared meanwhile wins
    await saveVoteCast(local, session, ids.walletId, ids.roundId, record, { create: true });
  } catch (e) {
    if (e instanceof VoteCastExists) {
      return exists();
    }
    throw e;
  }
  const res = await castVote(config, built.wire);
  return afterPost(deps, ids, record, res, a.submitAt);
};

/**
 * Settle a stored cast: one left `unknown`, one refused by a single
 * operator, or one whose shares did not all go out. The identical sealed
 * wire is re-sent (never rebuilt); the vote server relays it, recognises it
 * from its mempool, or refuses it as already spent and then settles it by
 * hash. A refusal is asked again of an operator that has not refused yet.
 */
export const resumeCast = async (
  deps: CastDeps,
  a: { walletId: string; roundId: string; proposalId: number; submitAt: number },
): Promise<CastOutcome> => {
  const { config, local, session } = deps;
  const ids = { walletId: a.walletId, roundId: a.roundId };
  const record = await loadVoteCast(local, session, a.walletId, a.roundId, a.proposalId);
  if (!record) {
    throw new Error('there is no stored vote to resume for this proposal');
  }
  if (record.refused) {
    const settled = await settleRefusal(deps, ids, record, {
      ok: false,
      status: 0,
      message: record.refused.message,
      txHash: record.txHash,
      rejected: true,
    });
    if (!('accepted' in settled)) {
      return settled;
    }
    return finish(deps, ids, { ...record, txHash: settled.accepted }, a.submitAt);
  }
  if (record.txHash) {
    return finish(deps, ids, { ...record, txHash: record.txHash }, a.submitAt);
  }
  const res = await castVote(config, record.wire, { mayBeOnChain: true });
  return afterPost(deps, ids, record, res, a.submitAt);
};
