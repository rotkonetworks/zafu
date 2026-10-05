/**
 * Zcash coinholder voting - read-only rounds + tallies (phase 1).
 *
 * Data flows through the functional service in services/voting: pinned
 * static config → dynamic config → vote servers. This screen owns no
 * protocol logic; it renders rounds and, per expanded round, the tally.
 *
 * Casting is phase 2 (needs the voting crypto crate in zcash-wasm), so
 * active rounds carry one honest line instead of dead buttons.
 */

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@repo/ui/lib/utils';
import { Segmented } from '@repo/ui/components/ui/segmented';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@repo/ui/components/ui/tooltip';
import { loadVoting, fetchTally } from '../../../services/voting/api';
import type { VotingRound, RoundStatus, VotingProposal } from '../../../services/voting/types';

// round status is a category, not an alarm - fg tokens only (DESIGN.md).
const STATUS_STYLE: Record<RoundStatus, string> = {
  starting: 'text-fg-muted',
  active: 'text-fg-high',
  tallying: 'text-fg-muted',
  completed: 'text-fg-muted',
  cancelled: 'text-fg-dim',
};

const formatEnd = (round: VotingRound): string => {
  // votingEnd comes from an unvalidated vote-server DTO; a missing/non-numeric
  // value would make `new Date(NaN).toISOString()` throw and crash the whole
  // round list (this runs per card). Guard before any date math.
  if (!Number.isFinite(round.votingEnd)) {
    return 'end unknown';
  }
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

/**
 * `OptionTally.weight` is `total_value` off the tally-results wire - a count
 * of 0.125-zec ballots, not zec and not zatoshi. Confirmed against the
 * protocol: `zcash_voting::governance::BALLOT_DIVISOR = 12_500_000` zatoshi
 * (one ballot), and valargroup's own reference UI (vote-sdk `ui/src/App.tsx`,
 * `ballotsToZEC`) renders finalized `total_value` the same way: `ballots *
 * BALLOT_DIVISOR / 1e8`. Converting here, once, keeps every number this
 * screen shows honest zec rather than a raw protocol count mislabeled.
 */
const BALLOT_ZATOSHI = 12_500_000;
const ballotsToZec = (ballots: number): number => (ballots * BALLOT_ZATOSHI) / 1e8;

// show every significant digit the conversion produces, zec's own precision
// (8dp) as the ceiling.
const formatZec = (zec: number): string =>
  zec.toLocaleString(undefined, { maximumFractionDigits: 8 });

const formatBallots = (ballots: number): string => ballots.toLocaleString();

const shortRoundId = (id: string): string => `${id.slice(0, 10)}…`;

export const ZcashVotePage = () => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // active vs past, same split the penumbra governance screen uses so the two
  // networks read identically. "active" is the one round taking votes; "past"
  // is everything settled or cancelled.
  const [filter, setFilter] = useState<'active' | 'past'>('active');
  // operator [TEST] rounds are hidden by default (they bury the real vote) but
  // can be revealed - only offered when some exist.
  const [showTest, setShowTest] = useState(false);

  const votingQ = useQuery({
    queryKey: ['zcash-vote', 'rounds'],
    staleTime: 60_000,
    queryFn: loadVoting,
  });

  const allRounds = votingQ.data?.rounds ?? [];
  const activeCount = allRounds.filter(r => r.status === 'active' && !r.isTest).length;
  const hasTest = allRounds.some(r => r.isTest);
  const rounds = allRounds.filter(r => {
    if (r.isTest && !showTest) {
      return false;
    }
    // a round still starting is upcoming, not past
    const current = r.status === 'active' || r.status === 'starting';
    return filter === 'active' ? current : !current;
  });

  const tabClass = (on: boolean) =>
    cn(
      'text-xs px-2 py-1 transition-colors',
      on ? 'text-fg bg-elev-2' : 'text-fg-muted hover:text-fg-high',
    );

  return (
    <div className='flex flex-col gap-3 p-4'>
      <div className='flex items-center justify-between'>
        <h2 className='text-title text-fg-high lowercase'>coinholder vote</h2>
        {activeCount > 0 && <span className='text-label text-fg-high'>{activeCount} active</span>}
      </div>

      {/* active / past tabs (+ test reveal), matching the penumbra screen */}
      <div className='flex items-center gap-2'>
        <Segmented
          label='round filter'
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'active' },
            { value: 'past', label: 'past' },
          ]}
        />
        {hasTest && (
          <button
            onClick={() => setShowTest(v => !v)}
            className={cn('ml-auto', tabClass(showTest))}
            title='operator dry-run rounds, not real coinholder votes'
          >
            {showTest ? 'hide test' : 'show test'}
          </button>
        )}
      </div>

      {votingQ.isLoading && (
        <div className='flex items-center justify-center py-12'>
          <div className='h-5 w-5 animate-spin border-2 border-zigner-gold border-t-transparent' />
        </div>
      )}

      {votingQ.error && (
        <div className='py-12 text-center'>
          <p className='text-body text-red-400'>voting rounds didn't load · please try again</p>
          <p className='mt-1 text-label text-fg-muted'>
            {votingQ.error instanceof Error ? votingQ.error.message : "the network didn't answer"}
          </p>
          <button
            onClick={() => void votingQ.refetch()}
            className='mt-2 text-body text-zigner-gold hover:underline'
          >
            try again
          </button>
        </div>
      )}

      {!votingQ.isLoading && !votingQ.error && rounds.length === 0 && (
        <div className='py-12 text-center'>
          <p className='text-body text-fg-muted'>
            {filter === 'active' ? 'no active rounds' : 'no past rounds'}
          </p>
          <p className='mt-1 text-label text-fg-dim'>
            {filter === 'active'
              ? 'coinholder polls appear here when a round opens.'
              : 'settled rounds and their tallies show here.'}
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
    queryFn: loadVoting,
  }).data?.config;

  const showTally = expanded && (round.status === 'tallying' || round.status === 'completed');
  const tallyQ = useQuery({
    queryKey: ['zcash-vote', 'tally', round.id],
    enabled: showTally && !!config,
    staleTime: 60_000,
    queryFn: () => fetchTally(config!, round.id),
  });

  return (
    <div className='border border-border-soft bg-elev-1'>
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
                className='text-label text-warning'
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
            expanded ? 'i-ph-caret-up' : 'i-ph-caret-down',
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
            <span>snapshot {(round.snapshotHeight ?? 0).toLocaleString()}</span>
            {round.discussionUrl && (
              <a
                href={round.discussionUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='flex items-center gap-1 text-fg-muted transition-colors hover:text-fg-high'
              >
                discussion
                <span className='i-ph-arrow-square-out h-3 w-3' />
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
                    <span className='bg-elev-2 px-1.5 py-0.5 text-label text-fg-muted'>
                      zip {p.zipNumber}
                    </span>
                  )}
                </div>
                {showTally && total > 0 && (
                  <span className='text-label text-fg-dim tabular'>
                    {formatZec(ballotsToZec(total))} zec tallied · {formatBallots(total)} ballots
                  </span>
                )}
                {p.options.map(opt => {
                  const weight = tally?.options.find(o => o.optionId === opt.id)?.weight ?? 0;
                  const pct = total > 0 ? (weight / total) * 100 : 0;
                  return (
                    <div key={opt.id} className='flex items-center gap-2'>
                      <span className='w-24 shrink-0 truncate text-label text-fg-muted lowercase'>
                        {opt.label}
                      </span>
                      {showTally ? (
                        <TallyBar
                          pct={pct}
                          round={round}
                          proposal={p}
                          optionId={opt.id}
                          optionLabel={opt.label}
                          weight={weight}
                          total={total}
                        />
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
              casting from zafu is coming - this round is view-only here for now.
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * One option's share, as a bar whose length is its share of the proposal's
 * tallied weight. The bar alone never carries the figures - they open on
 * hover, keyboard focus or tap, so the resting screen stays quiet while
 * every number the tally server sent us is still one touch away.
 */
const TallyBar = ({
  pct,
  round,
  proposal,
  optionId,
  optionLabel,
  weight: ballots,
  total: totalBallots,
}: {
  pct: number;
  round: VotingRound;
  proposal: VotingProposal;
  optionId: number;
  optionLabel: string;
  /** ballot count (0.125 zec each) from the wire - see `ballotsToZec`. */
  weight: number;
  total: number;
}) => {
  // Radix's own TooltipTrigger always closes on click (it composes our click
  // handler with an unconditional `context.onClose()` right after it, and
  // closes again, synchronously, on pointerdown if it was already open) - by
  // design, so that clicking a trigger never leaves a stale tooltip over
  // whatever the click did. We want the opposite here: the bar does nothing
  // but show its figures, so a tap should toggle them. `wasOpenRef` captures
  // the state on pointerdown, before Radix's own dismiss logic can touch it;
  // the click handler defers its toggle with a macrotask so it always lands
  // after Radix's synchronous close, instead of being overwritten by it.
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const wasOpenRef = useRef(false);
  const setOpen = (next: boolean) => {
    openRef.current = next;
    setOpenState(next);
  };
  const zec = ballotsToZec(ballots);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type='button'
            onPointerDown={() => {
              wasOpenRef.current = openRef.current;
            }}
            onClick={() => {
              const wasOpen = wasOpenRef.current;
              setTimeout(() => setOpen(!wasOpen), 0);
            }}
            aria-label={`${optionLabel}: ${formatZec(zec)} zec, ${pct.toFixed(2)}%`}
            className='flex flex-1 items-center gap-2 text-left'
          >
            <div className='h-1.5 flex-1 bg-elev-2'>
              <div className='h-full bg-zigner-gold/70' style={{ width: `${pct.toFixed(1)}%` }} />
            </div>
            <span className='w-12 shrink-0 text-right text-label text-fg-dim tabular'>
              {totalBallots > 0 ? `${pct.toFixed(1)}%` : '-'}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side='top'
          collisionPadding={8}
          className='flex max-w-[240px] flex-col gap-1 whitespace-normal lowercase'
        >
          <span className='text-fg-high'>{optionLabel}</span>
          <span className='tabular'>
            {formatZec(zec)} zec · {totalBallots > 0 ? `${pct.toFixed(2)}%` : 'no votes yet'}
          </span>
          <span className='text-fg-muted tabular'>{formatBallots(ballots)} ballots</span>
          <span className='text-fg-muted tabular'>
            {formatZec(ballotsToZec(totalBallots))} zec tallied total
          </span>
          <span className='text-fg-dim'>
            proposal {proposal.id} · option {optionId} · round {shortRoundId(round.id)}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
