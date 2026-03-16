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

type ProposalEntry = {
  id: bigint;
  title: string;
  description: string;
  kind: string;
  state: string;
  startBlock: bigint;
  endBlock: bigint;
};

function parseProposalKind(proposal: ProposalListResponse['proposal']): string {
  if (!proposal) return 'unknown';
  switch (proposal.payload.case) {
    case 'signaling': return 'signaling';
    case 'emergency': return 'emergency';
    case 'parameterChange': return 'parameter change';
    case 'communityPoolSpend': return 'community pool spend';
    case 'upgradePlan': return 'upgrade';
    case 'freezeIbcClient': return 'freeze IBC client';
    case 'unfreezeIbcClient': return 'unfreeze IBC client';
    default: return 'unknown';
  }
}

function parseState(state: ProposalListResponse['state']): string {
  if (!state) return 'unknown';
  switch (state.state.case) {
    case 'voting': return 'voting';
    case 'withdrawn': return 'withdrawn';
    case 'finished': return 'finished';
    case 'claimed': return 'claimed';
    default: return 'unknown';
  }
}

function stateColor(state: string): string {
  switch (state) {
    case 'voting': return 'text-green-400';
    case 'withdrawn': return 'text-yellow-400';
    case 'finished': return 'text-muted-foreground';
    case 'claimed': return 'text-muted-foreground';
    default: return 'text-muted-foreground';
  }
}

function voteLabel(vote: Vote_Vote): string {
  switch (vote) {
    case Vote_Vote.YES: return 'yes';
    case Vote_Vote.NO: return 'no';
    case Vote_Vote.ABSTAIN: return 'abstain';
    default: return '';
  }
}

function voteColor(vote: Vote_Vote): string {
  switch (vote) {
    case Vote_Vote.YES: return 'bg-green-500/20 text-green-400 hover:bg-green-500/30';
    case Vote_Vote.NO: return 'bg-red-500/20 text-red-400 hover:bg-red-500/30';
    case Vote_Vote.ABSTAIN: return 'bg-muted text-muted-foreground hover:bg-muted/80';
    default: return '';
  }
}

export function VotePage() {
  const [showInactive, setShowInactive] = useState(false);
  const [expandedId, setExpandedId] = useState<bigint | null>(null);
  const [votingId, setVotingId] = useState<bigint | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  const proposalsQuery = useQuery({
    queryKey: ['governance', 'proposals', showInactive],
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
      // build delegator vote transaction plan via view service
      const plan = await viewClient.transactionPlanner({
        delegatorVotes: [{
          proposal: proposalId,
          vote: { vote },
          startBlockHeight: 0n, // filled by planner
          startPosition: 0n,
          rateData: [],
        }],
      });

      if (!plan.plan) throw new Error('failed to create vote plan');

      // authorize and build
      const buildResponse = await viewClient.authorizeAndBuild({ transactionPlan: plan.plan });
      let transaction;
      for await (const msg of buildResponse) {
        if (msg.status.case === 'complete') {
          transaction = msg.status.value.transaction;
          break;
        }
      }
      if (!transaction) throw new Error('failed to build vote transaction');

      await viewClient.broadcastTransaction({ transaction, awaitDetection: true });
      void proposalsQuery.refetch();
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setVotingId(null);
    }
  };

  const proposals = proposalsQuery.data ?? [];
  const activeCount = proposals.filter(p => p.state === 'voting').length;

  return (
    <div className='flex flex-col gap-3 p-4'>
      <div className='flex items-center justify-between'>
        <h2 className='text-lg font-medium'>governance</h2>
        {activeCount > 0 && (
          <span className='text-xs text-green-400'>{activeCount} active</span>
        )}
      </div>

      {/* filter toggle */}
      <div className='flex items-center gap-2'>
        <button
          onClick={() => setShowInactive(false)}
          className={`text-xs px-2 py-1 rounded-md transition-colors ${!showInactive ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground'}`}
        >
          active
        </button>
        <button
          onClick={() => setShowInactive(true)}
          className={`text-xs px-2 py-1 rounded-md transition-colors ${showInactive ? 'text-foreground bg-muted' : 'text-muted-foreground hover:text-foreground'}`}
        >
          all
        </button>
      </div>

      {voteError && (
        <div className='text-xs text-red-400 bg-red-400/10 p-2 rounded-lg border border-red-400/40'>
          {voteError}
          <button onClick={() => setVoteError(null)} className='ml-2 underline'>dismiss</button>
        </div>
      )}

      {proposalsQuery.isLoading && (
        <div className='flex items-center justify-center py-12'>
          <div className='h-5 w-5 animate-spin border-2 border-primary border-t-transparent rounded-full' />
        </div>
      )}

      {proposalsQuery.error && (
        <div className='text-center py-12'>
          <p className='text-sm text-red-400'>failed to load proposals</p>
          <button onClick={() => void proposalsQuery.refetch()} className='text-sm text-primary hover:underline mt-1'>
            retry
          </button>
        </div>
      )}

      {!proposalsQuery.isLoading && proposals.length === 0 && (
        <div className='text-center py-12'>
          <p className='text-sm text-muted-foreground'>
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
            <div key={String(p.id)} className='rounded-lg border border-border/40 bg-card'>
              {/* header */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : p.id)}
                className='w-full flex items-start justify-between p-3 text-left hover:bg-muted/50 transition-colors'
              >
                <div className='flex-1 min-w-0'>
                  <div className='flex items-center gap-2'>
                    <span className='text-[10px] font-mono text-muted-foreground'>#{String(p.id)}</span>
                    <span className={`text-[10px] ${stateColor(p.state)}`}>{p.state}</span>
                    <span className='text-[10px] text-muted-foreground'>{p.kind}</span>
                  </div>
                  <p className='text-sm mt-0.5 truncate'>{p.title}</p>
                </div>
                {isExpanded ? <span className='i-lucide-chevron-up h-4 w-4 shrink-0 text-muted-foreground' /> : <span className='i-lucide-chevron-down h-4 w-4 shrink-0 text-muted-foreground' />}
              </button>

              {/* expanded detail */}
              {isExpanded && (
                <div className='border-t border-border/40 p-3'>
                  <p className='text-xs text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto'>
                    {p.description || 'no description'}
                  </p>

                  <div className='flex items-center gap-3 mt-2 text-[10px] text-muted-foreground'>
                    <span>start: {p.startBlock.toLocaleString()}</span>
                    <span>end: {p.endBlock.toLocaleString()}</span>
                  </div>

                  {/* vote buttons */}
                  {canVote && (
                    <div className='flex gap-2 mt-3'>
                      {[Vote_Vote.YES, Vote_Vote.NO, Vote_Vote.ABSTAIN].map(v => (
                        <button
                          key={v}
                          onClick={() => void handleVote(p.id, v)}
                          disabled={isVoting}
                          className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${voteColor(v)}`}
                        >
                          {isVoting ? '...' : voteLabel(v)}
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
