/**
 * Custody: who a multisig is made of, written on the channel log rather than into
 * a chat message.
 *
 * A group forming a threshold wallet has to agree on three things and keep them
 * stable for as long as the ceremony runs: the roster (which identities sign), the
 * threshold, and the artifact the shares were cut for (a group verifying key, or
 * the wallet address that falls out of it). Each one is a fact a later auditor
 * needs, and each is useless in a chat window - the window sweeps, the order is not
 * total, and a corrected roster is indistinguishable from a forged one.
 *
 * So a roster is a `custody` record on the channel log, where it inherits what that
 * log already guarantees: signed, hash-chained, totally ordered, replayable from
 * genesis by anyone holding the same records. {@link custodyStateAt} is the replay -
 * what a client shows as "the multisig" at a log index.
 *
 * What a custody record deliberately is not:
 *
 * - **Not key material.** A log meant to be shared, archived and audited is the
 *   last place a share may appear. There is no field for one here, and
 *   `room/commands.ts` refuses a `/frost` line that looks like one.
 * - **Not the ceremony.** FROST rounds run in the group session (`@zafu/zid`,
 *   round-structured over pairwise channels). This is the durable result of that
 *   run, pinned so two participants cannot drift to two different ceremonies.
 * - **Not a scheme.** `scheme` is data (`'zcash-p2sh-frost'`), so a second
 *   threshold scheme is a string rather than a fork of this module.
 *
 * The log cannot prove a roster is the one the ceremony agreed to: a record is
 * signed by one author, so a roster is *auditable* and not *self-authenticating*.
 * That is why `fingerprint` is required - the roster is checkable against the
 * artifact the shares were cut for, and the out-of-band comparison of that
 * fingerprint between participants is the verification. What the log removes is the
 * ambiguity about which roster is being compared.
 *
 * The two planes stay separate on purpose. The plan a group talks through lives in
 * the room (ephemeral, cheap, no durable storage); the roster and the artifact pin
 * live here, where `verifyChain` judges them and an archive can keep them. A
 * custody record is a *fact about a wallet*, never an instruction to a participant.
 */

import { lpText, signedFields, u32be } from '@zafu/zid';

import type { ChannelBody, ChannelRecord } from './channel-log';

/** one participant in a custody set. */
export interface CustodyMember {
  /** the identity that signs this participant's records: their channel key. */
  readonly ed25519: string;
  /** the key peers deliver to them with, when it is not the ed25519 key. */
  readonly relayKey?: string;
  /** the post-quantum sealing key they advertise (X-Wing), when known. */
  readonly sealKey?: string;
}

/** the body a channel record carries. Declared in `channel-log`; this is its shape. */
export type CustodyBody = Extract<ChannelBody, { kind: 'custody' }>;

/** a custody body before it is signed: what a caller has to supply. */
export type CustodyProposal = Omit<CustodyBody, 'kind'>;

/** a scheme name: lowercase, and short enough to read in a notice. */
const SCHEME_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

/**
 * A fingerprint is whatever the ceremony printed for the group key it produced -
 * a hex digest, or a bech32m address's payload. Lowercase letters and digits, at
 * least 8 of them, so a fingerprint typed into a command line is never ambiguous.
 */
const FINGERPRINT_RE = /^[0-9a-z]{8,128}$/;

export const isScheme = (scheme: string): boolean => SCHEME_RE.test(scheme);

export const isFingerprint = (fingerprint: string): boolean => FINGERPRINT_RE.test(fingerprint);

/**
 * The canonical form of a roster: keys lowercase and trimmed, and an absent
 * optional key left absent rather than present-and-empty.
 *
 * Two participants who list the same keys have to hash the same bytes, and hex is
 * the one spelling of a key that is unambiguously one key. `custodyBodyBytes` runs
 * this itself, so a body cannot reach the signature in a shape nobody else will
 * reproduce.
 */
export const canonicalRoster = (roster: readonly CustodyMember[]): readonly CustodyMember[] =>
  roster.map(member => ({
    ed25519: member.ed25519.trim().toLowerCase(),
    ...(member.relayKey ? { relayKey: member.relayKey.trim().toLowerCase() } : {}),
    ...(member.sealKey ? { sealKey: member.sealKey.trim().toLowerCase() } : {}),
  }));

/**
 * The bytes signed for a custody record, in the same canonical encoding the rest of
 * the log uses: a domain string, then length-prefixed fields, so a second
 * implementation in another language can recompute them exactly.
 *
 * The roster is a flat sequence of (identity, relay key, sealing key) triples, each
 * field length-prefixed, so a roster of any length encodes one way and only one way.
 */
export const custodyBodyBytes = (body: CustodyBody): Uint8Array =>
  signedFields('zid-chan-custody-v1', [
    lpText(body.scheme.trim().toLowerCase()),
    u32be(body.threshold),
    u32be(body.epoch),
    lpText(body.fingerprint.trim().toLowerCase()),
    ...canonicalRoster(body.roster).flatMap(member => [
      lpText(member.ed25519),
      lpText(member.relayKey ?? ''),
      lpText(member.sealKey ?? ''),
    ]),
  ]);

/**
 * Every reason this is not a roster a ceremony could run, in the order a reader
 * wants them. Empty means it is one.
 *
 * `verifyChain` refuses a custody record that fails this, so a malformed roster
 * cannot be *in* the log and then be replayed by every client as the multisig. The
 * same function is what a UI shows before anything is signed, which is why it
 * returns reasons rather than a boolean.
 */
export const custodyProblems = (proposal: CustodyProposal): readonly string[] => {
  const problems: string[] = [];
  const roster = canonicalRoster(proposal.roster);

  if (!isScheme(proposal.scheme)) {
    problems.push(`"${proposal.scheme}" is not a scheme name (lowercase letters, digits, dashes)`);
  }
  if (!isFingerprint(proposal.fingerprint)) {
    problems.push('a fingerprint is 8-128 lowercase letters or digits, as the ceremony printed it');
  }
  if (!Number.isInteger(proposal.epoch) || proposal.epoch < 1) {
    problems.push('an epoch is an integer of at least 1');
  }
  if (roster.length === 0) {
    problems.push('a custody roster needs at least one member');
  }
  if (
    !Number.isInteger(proposal.threshold) ||
    proposal.threshold < 1 ||
    proposal.threshold > roster.length
  ) {
    problems.push(`a threshold of ${proposal.threshold} is not between 1 and ${roster.length}`);
  }

  const seen = new Set<string>();
  for (const member of roster) {
    if (!/^[0-9a-f]{64}$/.test(member.ed25519)) {
      problems.push(`"${member.ed25519}" is not a 64-character hex identity`);
      continue;
    }
    if (seen.has(member.ed25519)) {
      problems.push(`${member.ed25519} is listed twice`);
    }
    seen.add(member.ed25519);
  }

  return problems;
};

/** one roster change, as replayed from the log. */
export interface CustodyEvent {
  /** the log index the record sits at. */
  readonly at: number;
  /** who wrote it. */
  readonly by: string;
  readonly scheme: string;
  readonly threshold: number;
  readonly epoch: number;
  readonly fingerprint: string;
  /** the roster this record puts in force, canonical. */
  readonly roster: readonly CustodyMember[];
  /** identities this record added, relative to the record before it. */
  readonly added: readonly string[];
  /** identities it dropped, so "did a custodian leave?" has a mechanical answer. */
  readonly removed: readonly string[];
}

/** the multisig as of one log index. */
export interface CustodyState {
  /** the roster in force, or null when no custody record precedes the index. */
  readonly roster: readonly CustodyMember[] | null;
  readonly threshold: number | null;
  readonly scheme: string | null;
  readonly epoch: number | null;
  readonly fingerprint: string | null;
  /** the record everything above comes from. */
  readonly at: number | null;
  readonly by: string | null;
  /** every custody record up to and including `at`, oldest first. */
  readonly history: readonly CustodyEvent[];
}

const EMPTY: Omit<CustodyState, 'history'> = {
  roster: null,
  threshold: null,
  scheme: null,
  epoch: null,
  fingerprint: null,
  at: null,
  by: null,
};

/**
 * Replay the custody records in a chain up to `at`, the way `channelStateAt`
 * replays modes: the newest record wins, every earlier one stays visible in
 * `history`, and nothing is stateful.
 *
 * This reads a chain that `verifyChain` accepted; it does not re-check authority,
 * and it does not check the epoch ordering either, because a chain that passed
 * verification cannot contain a roster that fails {@link custodyProblems} or an
 * epoch that fails to advance.
 */
export function custodyStateAt(records: readonly ChannelRecord[], at: number): CustodyState {
  const history: CustodyEvent[] = [];
  let previous: readonly string[] = [];

  for (let i = 0; i < Math.min(at, records.length); i += 1) {
    const record = records[i]!;
    if (record.body.kind !== 'custody') {
      continue;
    }
    const roster = canonicalRoster(record.body.roster);
    const keys = roster.map(member => member.ed25519);
    history.push({
      at: i + 1,
      by: record.author,
      scheme: record.body.scheme.trim().toLowerCase(),
      threshold: record.body.threshold,
      epoch: record.body.epoch,
      fingerprint: record.body.fingerprint.trim().toLowerCase(),
      roster,
      added: keys.filter(key => !previous.includes(key)),
      removed: previous.filter(key => !keys.includes(key)),
    });
    previous = keys;
  }

  const latest = history[history.length - 1];
  if (latest === undefined) {
    return { ...EMPTY, history };
  }

  return {
    roster: latest.roster,
    threshold: latest.threshold,
    scheme: latest.scheme,
    epoch: latest.epoch,
    fingerprint: latest.fingerprint,
    at: latest.at,
    by: latest.by,
    history,
  };
}
