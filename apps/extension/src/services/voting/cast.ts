/**
 * One hot vote, from proof to helper shares.
 *
 *   1. ZKP #2 + signed cast in the worker (cast_vote_hot_wire)
 *   2. seal the recovery bundle, the wire and the next delegation state
 *      BEFORE anything is sent, so a crash or a lost answer can resume
 *   3. POST /cast-vote; keep the tx hash
 *   4. wait for inclusion, read the vote commitment's tree position from
 *      the tx (checked against the tree's leaves). castPosition polls for
 *      about two minutes; a cast still pending after that stays sealed for
 *      resumeCast, which a scheduler outside the popup should drive once a
 *      cast UI exists
 *   5. build the helper shares from the bundle at that position (no proof
 *      reruns, so they match the commitment on chain) and send them, one
 *      share per request
 *   6. only now store the next delegation state: until the cast is on chain,
 *      the old one is still the valid one
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
import { castPosition, castVote, roundParamsJson, submitShares } from './api';
import type { CastPosition, RoundParams } from './api';
import {
  deleteVoteCast,
  loadVoteCast,
  saveDelegationState,
  saveVoteCast,
  type VoteCastRecord,
} from './persistence';
import type { VotingServiceConfig } from './types';

export interface CastDeps {
  config: VotingServiceConfig;
  local: ExtensionStorage<LocalStorageState>;
  session: ExtensionStorage<SessionStorageState>;
}

export type CastOutcome =
  /** the chain or server refused it; nothing was spent, the record is gone */
  | { state: 'refused'; message: string }
  /** it may have landed: resumeCast settles it */
  | { state: 'unknown'; message: string; txHash?: string }
  /** on chain; `queued` of the `total` shares sent this time reached a helper */
  | {
      state: 'cast';
      txHash: string;
      position: CastPosition;
      total: number;
      queued: number;
      errors: string[];
    };

/**
 * From an accepted cast with a tx hash to queued shares and stored state.
 * Steps a previous run already finished are not redone: a known position is
 * not looked up again, and shares already queued are not sent twice (then
 * `total` and `queued` are 0: nothing was left to send).
 */
const finish = async (
  deps: CastDeps,
  walletId: string,
  roundId: string,
  record: VoteCastRecord & { txHash: string },
  submitAt: number,
): Promise<CastOutcome> => {
  const { config, local, session } = deps;
  let position = record.position;
  if (!position) {
    const voteCommitment = (JSON.parse(record.wire) as { vote_commitment: string }).vote_commitment;
    position = await castPosition(config, roundId, record.txHash, voteCommitment);
    // On chain: the next state is now the valid one for this bundle's next cast.
    await saveDelegationState(local, session, walletId, roundId, record.nextDelegationStateJson);
    await saveVoteCast(local, session, walletId, roundId, { ...record, position });
  }
  if (record.sharesQueued) {
    return { state: 'cast', txHash: record.txHash, position, total: 0, queued: 0, errors: [] };
  }
  const { sharesJson } = await buildVoteSharesFromRecoveryInWorker({
    commitmentBundleJson: record.commitmentBundleJson,
    vcTreePosition: position.vcPosition,
    submitAt,
  });
  const sent = await submitShares(config, sharesJson);
  if (sent.queued === sent.total) {
    await saveVoteCast(local, session, walletId, roundId, {
      ...record,
      position,
      sharesQueued: true,
    });
  }
  return { state: 'cast', txHash: record.txHash, position, ...sent };
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
  const roundId = a.round.voteRoundId;
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
  await saveVoteCast(local, session, a.walletId, roundId, record);

  const res = await castVote(config, built.wire);
  if (res.rejected) {
    await deleteVoteCast(local, a.walletId, roundId, record.proposalId);
    return { state: 'refused', message: res.message };
  }
  if (!res.ok || !res.txHash) {
    if (res.txHash) {
      await saveVoteCast(local, session, a.walletId, roundId, { ...record, txHash: res.txHash });
    }
    return { state: 'unknown', message: res.message, txHash: res.txHash };
  }
  const withHash = { ...record, txHash: res.txHash };
  await saveVoteCast(local, session, a.walletId, roundId, withHash);
  return finish(deps, a.walletId, roundId, withHash, a.submitAt);
};

/**
 * Settle a cast left `unknown` (or whose shares did not all go out): re-send
 * the identical sealed wire, which the vote server either relays, recognises
 * from its mempool, or refuses as already spent and then settles by hash.
 */
export const resumeCast = async (
  deps: CastDeps,
  a: { walletId: string; roundId: string; proposalId: number; submitAt: number },
): Promise<CastOutcome> => {
  const { config, local, session } = deps;
  const record = await loadVoteCast(local, session, a.walletId, a.roundId, a.proposalId);
  if (!record) {
    throw new Error('there is no stored vote to resume for this proposal');
  }
  let txHash = record.txHash;
  if (!txHash) {
    const res = await castVote(config, record.wire, { mayBeOnChain: true });
    if (res.rejected) {
      await deleteVoteCast(local, a.walletId, a.roundId, a.proposalId);
      return { state: 'refused', message: res.message };
    }
    if (!res.txHash || !res.ok) {
      return { state: 'unknown', message: res.message, txHash: res.txHash };
    }
    txHash = res.txHash;
  }
  const withHash = { ...record, txHash };
  await saveVoteCast(local, session, a.walletId, a.roundId, withHash);
  return finish(deps, a.walletId, a.roundId, withHash, a.submitAt);
};
