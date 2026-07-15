/**
 * Zcash coinholder voting — read-only rounds + tallies (phase 1).
 *
 * Data flows through the functional service in services/voting: pinned
 * static config → dynamic config → vote servers. This screen owns no
 * protocol logic; it renders rounds and, per expanded round, the tally.
 *
 * Casting is phase 2 (needs the voting crypto crate in zcash-wasm), so
 * active rounds carry one honest line instead of dead buttons.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@repo/ui/lib/utils';
import { loadVoting, fetchTally } from '../../../services/voting/api';
import { BUNDLED_PINNED_SOURCE } from '../../../services/voting/types';
import type { VotingRound, RoundStatus } from '../../../services/voting/types';

const STATUS_STYLE: Record<RoundStatus, string> = {
  active: 'text-green-400',
  tallying: 'text-yellow-400',
  completed: 'text-fg-muted',
  cancelled: 'text-fg-dim',
};

const formatEnd = (round: VotingRound): string => {
  const now = Date.now() / 1000;
  const dt = round.votingEnd - now;
  if (round.status === 'active' && dt > 0) {
    if (dt > 86400) {
      return `ends in ${Math.round(dt / 86400)}d`;
    }
    if (dt > 3600) {
      return `ends in ${Math.round(dt / 3600)}h`;
    }
    return 'ends soon';
  }
  return `ended ${new Date(round.votingEnd * 1000).toISOString().slice(0, 10)}`;
};

export const ZcashVotePage = () => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const votingQ = useQuery({
    queryKey: ['zcash-vote', 'rounds'],
    staleTime: 60_000,
    queryFn: () => loadVoting(BUNDLED_PINNED_SOURCE),
  });

  const rounds = votingQ.data?.rounds ?? [];
  const activeCount = rounds.filter(r => r.status === 'active').length;

  return (
    <div className='flex flex-col gap-3 p-4'>
      <div className='flex items-center justify-between'>
        <h2 className='text-title text-fg-high lowercase'>coinholder vote</h2>
        {activeCount > 0 && <span className='text-label text-green-400'>{activeCount} active</span>}
      </div>

      {votingQ.isLoading && (
        <div className='flex items-center justify-center py-12'>
          <div className='h-5 w-5 animate-spin border-2 border-zigner-gold border-t-transparent rounded-full' />
        </div>
      )}

      {votingQ.error && (
        <div className='py-12 text-center'>
          <p className='text-body text-red-400'>failed to load voting rounds</p>
          <p className='mt-1 text-label text-fg-muted'>
            {votingQ.error instanceof Error ? votingQ.error.message : 'network error'}
          </p>
          <button
            onClick={() => void votingQ.refetch()}
            className='mt-2 text-body text-zigner-gold hover:underline'
          >
            retry
          </button>
        </div>
      )}

      {!votingQ.isLoading && !votingQ.error && rounds.length === 0 && (
        <div className='py-12 text-center'>
          <p className='text-body text-fg-muted'>no voting rounds right now</p>
          <p className='mt-1 text-label text-fg-dim'>
            coinholder polls appear here when a round opens.
          </p>
        </div>
      )}

      <div className='flex flex-col gap-2'>
        {rounds.map(round => (
          <RoundCard
            key={round.id}
            round={round}
            expanded={expandedId === round.id}
            onToggle={() => setExpandedId(expandedId === round.id ? null : round.id)}
          />
        ))}
      </div>
    </div>
  );
};

const RoundCard = ({
  round,
  expanded,
  onToggle,
}: {
  round: VotingRound;
  expanded: boolean;
  onToggle: () => void;
}) => {
  const config = useQuery({
    queryKey: ['zcash-vote', 'rounds'],
    staleTime: 60_000,
    queryFn: () => loadVoting(BUNDLED_PINNED_SOURCE),
  }).data?.config;

  const showTally = expanded && (round.status === 'tallying' || round.status === 'completed');
  const tallyQ = useQuery({
    queryKey: ['zcash-vote', 'tally', round.id],
    enabled: showTally && !!config,
    staleTime: 60_000,
    queryFn: () => fetchTally(config!, round.id),
  });

  return (
    <div className='rounded-lg border border-border-soft bg-elev-1'>
      <button
        onClick={onToggle}
        className='flex w-full items-start justify-between p-3 text-left transition-colors hover:bg-elev-1'
      >
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <span className={cn('text-label lowercase', STATUS_STYLE[round.status])}>
              {round.status}
            </span>
            <span className='text-label text-fg-muted'>{formatEnd(round)}</span>
            {!round.inConfig && (
              <span
                className='text-label text-amber-400'
                title='round is not listed in the pinned voting config'
              >
                unverified
              </span>
            )}
          </div>
          <p className='mt-0.5 truncate text-body text-fg'>{round.title || 'untitled round'}</p>
        </div>
        <span
          className={cn(
            'h-4 w-4 shrink-0 text-fg-muted',
            expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down',
          )}
        />
      </button>

      {expanded && (
        <div className='border-t border-border-soft p-3 flex flex-col gap-3'>
          {round.description && (
            <p className='max-h-[160px] overflow-y-auto whitespace-pre-wrap text-label text-fg-muted'>
              {round.description}
            </p>
          )}

          <div className='flex items-center gap-3 text-label text-fg-dim tabular'>
            <span>snapshot {round.snapshotHeight.toLocaleString()}</span>
            {round.discussionUrl && (
              <a
                href={round.discussionUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='flex items-center gap-1 text-fg-muted transition-colors hover:text-fg-high'
              >
                discussion
                <span className='i-lucide-external-link h-3 w-3' />
              </a>
            )}
          </div>

          {round.proposals.map(p => {
            const tally = tallyQ.data?.proposals.find(t => t.proposalId === p.id);
            const total = tally?.options.reduce((sum, o) => sum + o.weight, 0) ?? 0;
            return (
              <div key={p.id} className='flex flex-col gap-1.5'>
                <div className='flex items-center gap-2'>
                  <span className='text-data text-fg-high'>{p.title || `proposal ${p.id}`}</span>
                  {p.zipNumber && (
                    <span className='rounded-sm bg-elev-2 px-1.5 py-0.5 text-label text-fg-muted'>
                      zip {p.zipNumber}
                    </span>
                  )}
                </div>
                {p.options.map(opt => {
                  const weight = tally?.options.find(o => o.optionId === opt.id)?.weight ?? 0;
                  const pct = total > 0 ? (weight / total) * 100 : 0;
                  return (
                    <div key={opt.id} className='flex items-center gap-2'>
                      <span className='w-24 shrink-0 truncate text-label text-fg-muted lowercase'>
                        {opt.label}
                      </span>
                      {showTally ? (
                        <>
                          <div className='h-1.5 flex-1 bg-elev-2'>
                            <div
                              className='h-full bg-zigner-gold/70'
                              style={{ width: `${pct.toFixed(1)}%` }}
                            />
                          </div>
                          <span className='w-12 shrink-0 text-right text-label text-fg-dim tabular'>
                            {total > 0 ? `${pct.toFixed(1)}%` : '—'}
                          </span>
                        </>
                      ) : (
                        <div className='h-px flex-1 bg-border-soft' />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {showTally && tallyQ.isLoading && (
            <p className='text-label text-fg-dim'>loading tally…</p>
          )}
          {showTally && tallyQ.error && (
            <p className='text-label text-fg-dim'>tally not available yet.</p>
          )}

          {round.status === 'active' && (
            <p className='border-t border-border-soft pt-2 text-label text-fg-dim lowercase'>
              casting from zafu is coming — this round is view-only here for now.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
