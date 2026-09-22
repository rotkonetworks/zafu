/**
 * Moderation arithmetic: the electorate, and whether a decision passed.
 *
 * The design (issues #46, #47) puts moderation in the application, never in the
 * relay: the relay cannot read content, so it cannot adjudicate it. This module is
 * the part of that application that is pure - replay a mode chain to get the
 * electorate at a point in the log, and tally verified votes against a rule set.
 * No transport, no storage, no clock beyond the log index, and no trusted counter:
 * every client recomputes the same answer from the same signed records.
 *
 * The IRC half: `+v` is the citizenship list. Speaking in a `+m` channel and
 * voting on moderation are the same privilege, so the electorate is an explicit,
 * signed, auditable set rather than "whoever shows up" - which is what makes a
 * vote mean something when identities are free to mint.
 *
 * The Reddit half: hiding is a decision with a threshold, not a power. `hide` and
 * `reveal` are separate votes with separate thresholds (reveal usually higher, so
 * hiding is sticky but reversible), and a decision window is measured in log
 * indices, because wall clocks disagree and the log does not.
 *
 * Caller responsibilities, stated so they cannot be forgotten:
 *   - votes passed here MUST have verified signatures already (the group envelope
 *     path verifies senders; a vote record is a signed statement like any other);
 *   - content is never here. Votes name an item HASH, because the content is
 *     end-to-end encrypted and this layer has no business holding it.
 */

/** A channel's rules, fixed at genesis: they are part of its identity, so a
 *  community that wants different rules forks instead of arguing. */
export interface ModerationRules {
  /** distinct votes needed to hide, as a fraction of the electorate */
  readonly hide: { readonly numerator: number; readonly denominator: number };
  /** distinct votes needed to reveal again (usually stricter than hiding) */
  readonly reveal: { readonly numerator: number; readonly denominator: number };
  /** no decision counts at all below this many voiced members */
  readonly minElectorate: number;
  /** how long a decision stays open, in log indices */
  readonly windowLogs: number;
}

export const DEFAULT_RULES: ModerationRules = {
  // a third of the electorate hides; half brings it back (hiding sticky, not final)
  hide: { numerator: 1, denominator: 3 },
  reveal: { numerator: 1, denominator: 2 },
  minElectorate: 5,
  windowLogs: 200,
};

/** A mode record: what an operator did, and to whom. Signed; `at` orders it. */
export interface ModeRecord {
  readonly channel: string;
  /** `+v`/`-v` voice, `+o`/`-o` operator, `+m`/`-m` moderated speech, `+i`/`-i` invite-only */
  readonly mode: '+v' | '-v' | '+o' | '-o' | '+m' | '-m' | '+i' | '-i';
  readonly subject: string;
  /** the operator who signed it (must be an operator at that log index) */
  readonly by: string;
  readonly at: number;
}

/** A vote: one member, one item, one decision, at a log index. */
export interface VoteRecord {
  readonly channel: string;
  /** hash of the item being judged - never the item itself */
  readonly item: string;
  readonly decision: 'hide' | 'reveal';
  readonly voter: string;
  readonly at: number;
}

export interface Tally {
  readonly item: string;
  readonly decision: 'hide' | 'reveal';
  /** distinct, eligible, in-window votes for this decision */
  readonly votes: readonly string[];
  readonly electorate: readonly string[];
  /** votes required for this decision under the rules */
  /** votes required for this decision; `Infinity` when the electorate is below the floor */
  readonly threshold: number;
  readonly passed: boolean;
  /** the log index this tally was taken at (the window's close, or `asOf` if sooner) */
  readonly asOf: number;
  /** why individual records were not counted - for the "moderate the moderation" view */
  readonly rejected: readonly { readonly voter: string; readonly reason: string }[];
}

/**
 * Replay a mode chain to get the operator set and the electorate as of `at`.
 * Records after `at` are ignored, so a decision can be audited against the
 * electorate it was actually decided by. A grant/revoke takes effect from its own
 * log index onward.
 */
export function modeStateAt(
  records: readonly ModeRecord[],
  at: number,
): { readonly voice: readonly string[]; readonly ops: readonly string[] } {
  const voice = new Set<string>();
  const ops = new Set<string>();
  for (const r of [...records].sort((x, y) => x.at - y.at)) {
    if (r.at > at) {
      continue;
    }
    const target = r.subject;
    switch (r.mode) {
      case '+v':
        voice.add(target);
        break;
      case '-v':
        voice.delete(target);
        break;
      case '+o':
        ops.add(target);
        break;
      case '-o':
        ops.delete(target);
        break;
      case '+m':
      case '-m':
      case '+i':
      case '-i':
        // these gate speech and entry, not membership: they change what a member
        // may do, never whether they are one
        break;
    }
  }
  return { voice: [...voice], ops: [...ops] };
}

const thresholdFor = (
  fraction: ModerationRules['hide'],
  electorateSize: number,
  rules: ModerationRules,
): number => {
  if (electorateSize < rules.minElectorate) {
    // Below the floor there is no quorum to reach: nothing can pass.
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil((electorateSize * fraction.numerator) / fraction.denominator);
};

/**
 * Tally one decision.
 *
 * Rules that make the result recomputable by every client, and defensible when
 * someone asks "why is this hidden?":
 *
 *   - a voter must be VOICED as of the vote's own log index (voice is the
 *     electorate, so `-v` removes the vote, `+v` after the window does not add one);
 *   - one vote per voter per decision: the FIRST record counts, so a voter cannot
 *     change their mind by sending twice and cannot be double-counted;
 *   - records outside `openedAt .. openedAt + windowLogs` are rejected, and there
 *     is no wall clock in the decision;
 *   - `hide` and `reveal` are tallied separately against their own thresholds, so
 *     a hide does not quietly satisfy a reveal and vice versa.
 */
export function tallyDecision(opts: {
  readonly item: string;
  readonly decision: 'hide' | 'reveal';
  readonly votes: readonly VoteRecord[];
  readonly modes: readonly ModeRecord[];
  readonly rules: ModerationRules;
  readonly openedAt: number;
  readonly asOf: number;
}): Tally {
  const closesAt = opts.openedAt + opts.rules.windowLogs;
  const at = Math.min(opts.asOf, closesAt);
  const electorate = modeStateAt(opts.modes, at).voice;

  const counted: string[] = [];
  const rejected: { voter: string; reason: string }[] = [];
  const seen = new Set<string>();

  const ordered = [...opts.votes].sort((a, b) => a.at - b.at);
  for (const vote of ordered) {
    if (vote.item !== opts.item || vote.decision !== opts.decision) {
      continue; // a different question; not a rejection to report
    }
    if (vote.at < opts.openedAt || vote.at > closesAt) {
      rejected.push({ voter: vote.voter, reason: 'outside the decision window' });
      continue;
    }
    if (seen.has(vote.voter)) {
      rejected.push({ voter: vote.voter, reason: 'already voted on this decision' });
      continue;
    }
    const voicedThen = modeStateAt(opts.modes, vote.at).voice;
    if (!voicedThen.includes(vote.voter)) {
      rejected.push({ voter: vote.voter, reason: 'not voiced when they voted' });
      continue;
    }
    seen.add(vote.voter);
    counted.push(vote.voter);
  }

  const threshold = thresholdFor(opts.rules[opts.decision], electorate.length, opts.rules);
  return {
    item: opts.item,
    decision: opts.decision,
    votes: counted,
    electorate,
    threshold,
    passed: counted.length >= threshold,
    asOf: at,
    rejected,
  };
}

/**
 * The visible state of an item: what a client should do by DEFAULT, given every
 * decision made about it. A hide is a default, never a deletion - so the answer is
 * always recoverable, and a client that shows moderated items is not doing
 * anything unusual, it is just declining to collapse them.
 */
export const itemIsHidden = (decisions: readonly Tally[]): boolean => {
  // The LATEST passed decision wins, ordered by the log index it was taken at - so
  // a later reveal restores an item, and a later hide re-hides it. Never a
  // deletion: a client showing moderated items is only declining to collapse them.
  const passed = decisions.filter(d => d.passed).sort((a, b) => a.asOf - b.asOf);
  const latest = passed[passed.length - 1];
  return latest === undefined ? false : latest.decision === 'hide';
};
