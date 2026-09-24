/**
 * penumbra governance voting page
 *
 * lists active and past proposals, allows delegator voting
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { governanceClient } from '../../../clients';
import { Vote_Vote } from '@penumbra-zone/protobuf/penumbra/core/component/governance/v1/governance_pb';
import type { ProposalListResponse } from '@penumbra-zone/protobuf/penumbra/core/component/governance/v1/governance_pb';
import { viewClient } from '../../../clients';
import { useStore } from '../../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../../state/keyring';
import { NetworkUnavailable } from '../../../shared/components/network-unavailable';
import { ZcashVotePage } from './zcash-vote';

interface ProposalEntry {
  id: bigint;
  title: string;
  description: string;
  kind: string;
  state: string;
  startBlock: bigint;
  endBlock: bigint;
  /** the whole proposal as JSON: what the chain will actually enact. */
  raw: string;
}

/**
 * The full proposal, not just its prose: for a parameter change this is the
 * old and new parameters the chain will apply, which the description can
 * misstate. Worth reading before voting.
 */
function proposalJson(proposal: NonNullable<ProposalListResponse['proposal']>): string {
  try {
    return JSON.stringify(proposal.toJson(), null, 2);
  } catch (e) {
    return `could not render proposal json: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function parseProposalKind(proposal: ProposalListResponse['proposal']): string {
  if (!proposal) {
    return 'unknown';
  }
  switch (proposal.payload.case) {
    case 'signaling':
      return 'signaling';
    case 'emergency':
      return 'emergency';
    case 'parameterChange':
      return 'parameter change';
    case 'communityPoolSpend':
      return 'community pool spend';
    case 'upgradePlan':
      return 'upgrade';
    case 'freezeIbcClient':
      return 'freeze IBC client';
    case 'unfreezeIbcClient':
      return 'unfreeze IBC client';
    default:
      return 'unknown';
  }
}

function parseState(state: ProposalListResponse['state']): string {
  if (!state) {
    return 'unknown';
  }
  switch (state.state.case) {
    case 'voting':
      return 'voting';
    case 'withdrawn':
      return 'withdrawn';
    case 'finished':
      return 'finished';
    case 'claimed':
      return 'claimed';
    default:
      return 'unknown';
  }
}

// proposal state is a category, not an alarm - fg tokens only (DESIGN.md).
function stateColor(state: string): string {
  switch (state) {
    case 'voting':
      return 'text-fg-high';
    default:
      return 'text-fg-muted';
  }
}

function voteLabel(vote: Vote_Vote): string {
  switch (vote) {
    case Vote_Vote.YES:
      return 'yes';
    case Vote_Vote.NO:
      return 'no';
    case Vote_Vote.ABSTAIN:
      return 'abstain';
    default:
      return '';
  }
}

/** icon carries the vote meaning; color stays on-token (no green/red category coding) */
function voteIcon(vote: Vote_Vote): string {
  switch (vote) {
    case Vote_Vote.YES:
      return 'i-ph-check';
    case Vote_Vote.NO:
      return 'i-ph-x';
    case Vote_Vote.ABSTAIN:
      return 'i-ph-minus';
    default:
      return '';
  }
}

export function VotePage() {
  const activeNetwork = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const [showInactive, setShowInactive] = useState(false);
  const [expandedId, setExpandedId] = useState<bigint | null>(null);
  const [rawId, setRawId] = useState<bigint | null>(null);
  const [votingId, setVotingId] = useState<bigint | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  // gate the network query via `enabled` so the hook still runs when on
  // another network — Rules of Hooks require a stable hook count.
  const isPenumbra = activeNetwork === 'penumbra';

  const proposalsQuery = useQuery({
    queryKey: ['governance', 'proposals', showInactive],
    enabled: isPenumbra,
    staleTime: 30_000,
    queryFn: async () => {
      const proposals: ProposalEntry[] = [];
      for await (const r of governanceClient.proposalList({ inactive: showInactive })) {
        if (r.proposal) {
          proposals.push({
            id: r.proposal.id,
            title: r.proposal.title,
            description: r.proposal.description,
            kind: parseProposalKind(r.proposal),
            state: parseState(r.state),
            startBlock: r.startBlockHeight,
            endBlock: r.endBlockHeight,
            raw: proposalJson(r.proposal),
          });
        }
      }
      // newest first
      proposals.sort((a, b) => Number(b.id - a.id));
      return proposals;
    },
  });

  const handleVote = async (proposalId: bigint, vote: Vote_Vote) => {
    setVotingId(proposalId);
    setVoteError(null);
    try {
      // The planner does NOT look these up: it finds the delegation notes
      // held at the proposal's start height and values each one with that
      // validator's rate data at the start. Passing 0 / [] (as this used to)
      // finds no notes, or finds notes but matches none of them - which could
      // plan a fee-only transaction that votes nothing.
      const { startBlockHeight, startPosition } = await governanceClient.proposalData({
        proposalId,
      });
      const rateData = [];
      for await (const r of governanceClient.proposalRateData({ proposalId })) {
        if (r.rateData) {
          rateData.push(r.rateData);
        }
      }

      const plan = await viewClient.transactionPlanner({
        // the account that votes (its delegation notes) and pays the fee
        source: { account: penumbraAccount },
        delegatorVotes: [
          {
            proposal: proposalId,
            vote: { vote },
            startBlockHeight,
            startPosition,
            rateData,
          },
        ],
      });

      if (!plan.plan) {
        throw new Error('failed to create vote plan');
      }
      // never broadcast a vote transaction that contains no vote
      if (!plan.plan.actions.some(a => a.action.case === 'delegatorVote')) {
        throw new Error(
          'this account had no staked UM when voting opened, so it has no votes on this proposal',
        );
      }

      // authorize and build
      const buildResponse = await viewClient.authorizeAndBuild({ transactionPlan: plan.plan });
      let transaction;
      for await (const msg of buildResponse) {
        if (msg.status.case === 'complete') {
          transaction = msg.status.value.transaction;
          break;
        }
      }
      if (!transaction) {
        throw new Error('failed to build vote transaction');
      }

      await viewClient.broadcastTransaction({ transaction, awaitDetection: true });
      void proposalsQuery.refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setVoteError(
        message.includes('no notes were found for voting')
          ? 'this account had no staked UM when voting opened, so it has no votes on this proposal'
          : message,
      );
    } finally {
      setVotingId(null);
    }
  };

  const proposals = proposalsQuery.data ?? [];
  const activeCount = proposals.filter(p => p.state === 'voting').length;

  // placeholder for other networks. Placed after every hook call so the
  // count stays stable across switches.
  if (activeNetwork === 'zcash') {
    return <ZcashVotePage />;
  }
  if (!isPenumbra) {
    return <NetworkUnavailable feature='governance' iconClass='i-ph-check-square-offset' />;
  }

  return (
    <div className='flex flex-col gap-3 p-4'>
      <div className='flex items-center justify-between'>
        <h2 className='text-lg font-medium'>governance</h2>
        {activeCount > 0 && <span className='text-xs text-fg-high'>{activeCount} active</span>}
      </div>

      {/* filter toggle */}
      <div className='flex items-center gap-2'>
        <button
          onClick={() => setShowInactive(false)}
          className={`text-xs px-2 py-1 rounded-md transition-colors ${!showInactive ? 'text-fg bg-elev-2' : 'text-fg-muted hover:text-fg-high'}`}
        >
          active
        </button>
        <button
          onClick={() => setShowInactive(true)}
          className={`text-xs px-2 py-1 rounded-md transition-colors ${showInactive ? 'text-fg bg-elev-2' : 'text-fg-muted hover:text-fg-high'}`}
        >
          all
        </button>
      </div>

      {voteError && (
        <div className='text-xs text-red-400 bg-red-400/10 p-2 rounded-lg border border-red-400/40'>
          {voteError}
          <button onClick={() => setVoteError(null)} className='ml-2 underline'>
            dismiss
          </button>
        </div>
      )}

      {proposalsQuery.isLoading && (
        <div className='flex items-center justify-center py-12'>
          <div className='h-5 w-5 animate-spin border-2 border-zigner-gold border-t-transparent rounded-full' />
        </div>
      )}

      {proposalsQuery.error && (
        <div className='text-center py-12'>
          <p className='text-sm text-red-400'>failed to load proposals</p>
          <button
            onClick={() => void proposalsQuery.refetch()}
            className='text-sm text-zigner-gold hover:underline mt-1'
          >
            retry
          </button>
        </div>
      )}

      {!proposalsQuery.isLoading && proposals.length === 0 && (
        <div className='text-center py-12'>
          <p className='text-sm text-fg-muted'>
            {showInactive ? 'no proposals found' : 'no active proposals'}
          </p>
        </div>
      )}

      {/* proposal list */}
      <div className='flex flex-col gap-2'>
        {proposals.map(p => {
          const isExpanded = expandedId === p.id;
          const isVoting = votingId === p.id;
          const canVote = p.state === 'voting';

          return (
            <div key={String(p.id)} className='rounded-lg border border-border-soft bg-elev-1'>
              {/* header */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : p.id)}
                className='w-full flex items-start justify-between p-3 text-left hover:bg-elev-1 transition-colors'
              >
                <div className='flex-1 min-w-0'>
                  <div className='flex items-center gap-2'>
                    <span className='text-label font-mono text-fg-muted'>#{String(p.id)}</span>
                    <span className={`text-label ${stateColor(p.state)}`}>{p.state}</span>
                    <span className='text-label text-fg-muted'>{p.kind}</span>
                  </div>
                  <p className='text-sm mt-0.5 truncate'>{p.title}</p>
                </div>
                {isExpanded ? (
                  <span className='i-ph-caret-up h-4 w-4 shrink-0 text-fg-muted' />
                ) : (
                  <span className='i-ph-caret-down h-4 w-4 shrink-0 text-fg-muted' />
                )}
              </button>

              {/* expanded detail */}
              {isExpanded && (
                <div className='border-t border-border-soft p-3'>
                  <p className='text-xs text-fg-muted whitespace-pre-wrap max-h-[200px] overflow-y-auto'>
                    {p.description || 'no description'}
                  </p>

                  <div className='flex items-center gap-3 mt-2 text-label text-fg-muted'>
                    <span>start: {p.startBlock.toLocaleString()}</span>
                    <span>end: {p.endBlock.toLocaleString()}</span>
                    <span className='flex-1' />
                    <button
                      onClick={() => setRawId(rawId === p.id ? null : p.id)}
                      className='flex items-center gap-1 hover:text-fg-high'
                    >
                      <span className='i-ph-brackets-curly h-3.5 w-3.5' />
                      {rawId === p.id ? 'hide json' : 'raw json'}
                    </button>
                  </div>

                  {rawId === p.id && (
                    <div className='mt-2 rounded-md border border-border-soft bg-elev-2'>
                      <div className='flex items-center justify-between px-2 py-1 text-label text-fg-muted'>
                        <span>what the chain enacts</span>
                        <button
                          onClick={() => void navigator.clipboard.writeText(p.raw)}
                          className='flex items-center gap-1 hover:text-fg-high'
                        >
                          <span className='i-ph-copy h-3.5 w-3.5' />
                          copy
                        </button>
                      </div>
                      <pre className='max-h-[260px] overflow-auto px-2 pb-2 font-mono text-[10px] leading-snug text-fg-high whitespace-pre'>
                        {p.raw}
                      </pre>
                    </div>
                  )}

                  {/* vote buttons */}
                  {canVote && (
                    <div className='flex gap-2 mt-3'>
                      {[Vote_Vote.YES, Vote_Vote.NO, Vote_Vote.ABSTAIN].map(v => (
                        <button
                          key={v}
                          onClick={() => void handleVote(p.id, v)}
                          disabled={isVoting}
                          className='flex flex-1 items-center justify-center gap-1 py-1.5 rounded-md bg-elev-2 text-xs font-medium text-fg-high transition-colors hover:bg-elev-1 disabled:opacity-50'
                        >
                          {isVoting ? (
                            '...'
                          ) : (
                            <>
                              <span className={`${voteIcon(v)} h-3.5 w-3.5`} />
                              {voteLabel(v)}
                            </>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { VotePage as default };
