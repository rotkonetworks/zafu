/**
 * Channels: a genesis record, a hash-chained log, and whoever is allowed to write
 * what into it.
 *
 * This is the piece that makes the moderation arithmetic (`vote.ts`) mean
 * anything. `modeStateAt` replays a mode chain to get the electorate, but a chain
 * is only an electorate if someone authorized each link: without a rule about WHO
 * may grant voice, a newcomer signs a `+v` for themselves and votes themselves
 * into power. So authority here is evaluated the way it has to be -
 *
 *     a record is authorized by the state BEFORE it, never by its own effect
 *
 * - and that single ordering rule is what stops self-promotion, self-voicing and
 * self-deoping. The founder is an operator by construction (the genesis is their
 * signature); every other operator exists because an operator granted them.
 *
 * The log is hash-chained (each record carries the hash of its predecessor), so it
 * is tamper-evident and totally ordered without a server: indices are the clock,
 * exactly as the vote windows assume. Two parties who hold the same records
 * compute the same electorate, the same tallies and the same answer to "is this
 * hidden", because none of it is stateful.
 *
 * What this module is NOT: a transport, a relay, or a place content lives. Items
 * are referenced by hash; the content is end-to-end encrypted somewhere else and
 * the channel never sees it. Publishing the log is the app's business (issue #46,
 * "where does the decision log live"), and nothing here depends on the answer.
 */

import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import { lpText, signedFields, u32be } from '@zafu/zid';
import {
  itemIsHidden,
  modeStateAt,
  tallyDecision,
  type ModeRecord,
  type ModerationRules,
  type Tally,
  type VoteRecord,
} from './vote';

/** the key material a channel record is signed with; `ZidIdentity` satisfies it. */
export interface ChannelSigner {
  readonly pubkey: string;
  sign(bytes: Uint8Array): Promise<string>;
}

export interface ChannelGenesis {
  readonly id: string;
  readonly founder: string;
  readonly rules: ModerationRules;
  readonly sig: string;
}

export type ChannelBody =
  | { readonly kind: 'mode'; readonly mode: ModeRecord['mode']; readonly subject: string }
  | { readonly kind: 'vote'; readonly item: string; readonly decision: 'hide' | 'reveal' }
  | { readonly kind: 'open'; readonly item: string; readonly decision: 'hide' | 'reveal' };

export interface ChannelRecord {
  /** log index: 1-based, because the genesis is index 0 */
  readonly at: number;
  /** hex hash of the record before this one (the genesis hash at index 1) */
  readonly prev: string;
  readonly author: string;
  readonly body: ChannelBody;
  readonly sig: string;
}

export interface ChainCheck {
  readonly ok: boolean;
  /** index of the first record that failed, when it did */
  readonly at?: number;
  readonly reason?: string;
}

const DOMAIN_GENESIS = 'zid-chan-genesis-v1';
const DOMAIN_RECORD = 'zid-chan-record-v1';

const hex = (bytes: Uint8Array): string => bytesToHex(bytes);
const hash = (bytes: Uint8Array): string => hex(sha256(bytes));

/** the rules are part of the channel's identity, so they are signed explicitly -
 *  field by field, never via JSON, whose key order nobody promises. */
const rulesBytes = (rules: ModerationRules): Uint8Array =>
  signedFields('zid-rules-v1', [
    u32be(rules.hide.numerator),
    u32be(rules.hide.denominator),
    u32be(rules.reveal.numerator),
    u32be(rules.reveal.denominator),
    u32be(rules.minElectorate),
    u32be(rules.windowLogs),
  ]);

const genesisBytes = (id: string, founder: string, rules: ModerationRules): Uint8Array =>
  // the rules are hashed into the signed bytes: a fingerprint is enough to bind
  // them, and signing them twice would be signing the same thing twice
  signedFields(DOMAIN_GENESIS, [lpText(id), lpText(founder), sha256(rulesBytes(rules))]);

/** the hash a record chains from: the signed genesis, signature included. */
export const genesisHash = (genesis: ChannelGenesis): string =>
  hash(genesisBytes(genesis.id, genesis.founder, genesis.rules));

const bodyBytes = (body: ChannelBody): Uint8Array => {
  switch (body.kind) {
    case 'mode':
      return signedFields('zid-chan-mode-v1', [lpText(body.mode), lpText(body.subject)]);
    case 'vote':
      return signedFields('zid-chan-vote-v1', [lpText(body.item), lpText(body.decision)]);
    case 'open':
      return signedFields('zid-chan-open-v1', [lpText(body.item), lpText(body.decision)]);
  }
};

export const recordBytes = (
  channel: string,
  at: number,
  prev: string,
  body: ChannelBody,
): Uint8Array =>
  signedFields(DOMAIN_RECORD, [
    lpText(channel),
    u32be(at),
    lpText(prev),
    sha256(bodyBytes(body)),
  ]);

/**
 * Found a channel. The founder is an operator by construction - there is no other
 * way in - and the rules signed here are the rules every later decision is judged
 * by, which is why a community that wants different rules forks instead.
 */
export async function createGenesis(opts: {
  readonly id: string;
  readonly founder: ChannelSigner;
  readonly rules: ModerationRules;
}): Promise<ChannelGenesis> {
  const founder = opts.founder.pubkey.toLowerCase();
  const sig = await opts.founder.sign(genesisBytes(opts.id, founder, opts.rules));
  return { id: opts.id, founder, rules: opts.rules, sig };
}

/** Append a record: the caller says what, the log decides where. */
export async function appendRecord(opts: {
  readonly genesis: ChannelGenesis;
  readonly records: readonly ChannelRecord[];
  readonly author: ChannelSigner;
  readonly body: ChannelBody;
}): Promise<ChannelRecord> {
  const at = opts.records.length + 1;
  const last = opts.records[opts.records.length - 1];
  const prev = last === undefined ? genesisHash(opts.genesis) : recordHash(opts.genesis.id, last);
  const author = opts.author.pubkey.toLowerCase();
  const sig = await opts.author.sign(recordBytes(opts.genesis.id, at, prev, opts.body));
  return { at, prev, author, body: opts.body, sig };
}

/**
 * The hash a record contributes to the chain. Records do not carry the channel id
 * (the genesis does), so the caller supplies it - which also means a record from
 * one channel can never be replayed into another.
 */
export const recordHash = (channel: string, record: ChannelRecord): string =>
  hash(recordBytes(channel, record.at, record.prev, record.body));

/**
 * Verify a chain end to end: order, linkage, signatures, and authority.
 *
 * Authority is checked against the state BEFORE each record, which is what stops
 * the two classic attacks: a `+o` record that would authorize itself, and a `+v`
 * record from someone who is not an operator. The first failure stops the walk,
 * with the index and a reason a client can show a user.
 */
export async function verifyChain(opts: {
  readonly genesis: ChannelGenesis;
  readonly records: readonly ChannelRecord[];
  readonly signer: { verify(bytes: Uint8Array, sig: string, pubkey: string): Promise<boolean> };
}): Promise<ChainCheck> {
  const { genesis, records } = opts;

  const genesisOk = await opts.signer
    .verify(genesisBytes(genesis.id, genesis.founder, genesis.rules), genesis.sig, genesis.founder)
    .catch(() => false);
  if (!genesisOk) {
    return { ok: false, at: 0, reason: 'the genesis signature does not verify' };
  }

  let prevHash = genesisHash(genesis);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    const expectedAt = i + 1;
    if (record.at !== expectedAt) {
      return { ok: false, at: record.at, reason: `expected log index ${expectedAt}` };
    }
    if (record.prev !== prevHash) {
      return { ok: false, at: record.at, reason: 'does not chain to the previous record' };
    }

    // Authority is the state BEFORE this record. Applicability is not: an operator
    // may deop themselves, and the granted authority must still have existed when
    // they did it.
    const before = modeStateAt(modesOf(genesis.founder, records.slice(0, i)), record.at);
    const authorized =
      record.body.kind === 'mode'
        ? before.ops.includes(record.author)
        : before.voice.includes(record.author);
    if (!authorized) {
      return {
        ok: false,
        at: record.at,
        reason:
          record.body.kind === 'mode'
            ? `${record.author} was not an operator when this mode record was written`
            : `${record.author} was not voiced when this ${record.body.kind} record was written`,
      };
    }

    const sigOk = await opts.signer
      .verify(
        recordBytes(genesis.id, record.at, record.prev, record.body),
        record.sig,
        record.author,
      )
      .catch(() => false);
    if (!sigOk) {
      return { ok: false, at: record.at, reason: 'the record signature does not verify' };
    }

    prevHash = recordHash(genesis.id, record);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// derived views (consume a chain that passed `verifyChain`)
// ---------------------------------------------------------------------------

/**
 * The mode records of a chain, as `vote.ts` wants them - SEEDED with the genesis
 * operator. That seed is the whole reason the log has an authority at all: the
 * founder is an operator by construction (`createGenesis` is their signature), and
 * without replaying that fact first, no founder-written record would be
 * authorized and the chain could never begin.
 *
 * `channel` is blank in these views: the chain already carries identity, so the
 * tallies are channel-local by construction.
 */
const modesOf = (founder: string, records: readonly ChannelRecord[]): ModeRecord[] => [
  { channel: '', mode: '+o', subject: founder, by: founder, at: 0 },
  ...records.flatMap((r, i) =>
    r.body.kind === 'mode'
      ? [
          {
            channel: '',
            mode: r.body.mode,
            subject: r.body.subject,
            by: r.author,
            at: i + 1,
          } satisfies ModeRecord,
        ]
      : [],
  ),
];

/** the vote records of a chain, as `vote.ts` wants them. */
const votesOf = (records: readonly ChannelRecord[]): VoteRecord[] =>
  records.flatMap((r, i) =>
    r.body.kind === 'vote'
      ? [
          {
            channel: '',
            item: r.body.item,
            decision: r.body.decision,
            voter: r.author,
            at: i + 1,
          } satisfies VoteRecord,
        ]
      : [],
  );

/** the electorate and operator set at a log index. */
export function channelStateAt(
  founder: string,
  records: readonly ChannelRecord[],
  at: number,
): { readonly voice: readonly string[]; readonly ops: readonly string[] } {
  return modeStateAt(modesOf(founder, records), at);
}

export interface DecisionView {
  readonly item: string;
  /** the latest decision opened for this item, if any */
  readonly opened: { readonly at: number; readonly decision: 'hide' | 'reveal' } | null;
  readonly hide: Tally | null;
  readonly reveal: Tally | null;
  readonly hidden: boolean;
}

/**
 * What a client should show for one item: the latest opened decision, both tallies
 * inside its window, and whether that leaves the item collapsed by default. Every
 * number is recomputed from the chain, so two clients that disagree about "is this
 * hidden" have a concrete thing to compare.
 */
export function decisionView(opts: {
  readonly genesis: ChannelGenesis;
  readonly records: readonly ChannelRecord[];
  readonly item: string;
  /** log index to judge at; defaults to the newest record */
  readonly asOf?: number;
}): DecisionView {
  const { records, genesis } = opts;
  const asOf = opts.asOf ?? records.length;

  const opens = records
    .map((r, i) => ({ r, at: i + 1 }))
    .filter(
      (
        x,
      ): x is { r: ChannelRecord & { body: Extract<ChannelBody, { kind: 'open' }> }; at: number } =>
        x.r.body.kind === 'open' && x.r.body.item === opts.item,
    );
  const latest = opens[opens.length - 1];
  if (latest === undefined) {
    return { item: opts.item, opened: null, hide: null, reveal: null, hidden: false };
  }

  const modes = modesOf(genesis.founder, records);
  const votes = votesOf(records);
  const hide = tallyDecision({
    item: opts.item,
    decision: 'hide',
    votes,
    modes,
    rules: genesis.rules,
    openedAt: latest.at,
    asOf,
  });
  const reveal = tallyDecision({
    item: opts.item,
    decision: 'reveal',
    votes,
    modes,
    rules: genesis.rules,
    openedAt: latest.at,
    asOf,
  });

  return {
    item: opts.item,
    opened: { at: latest.at, decision: latest.r.body.decision },
    hide,
    reveal,
    hidden: itemIsHidden([hide, reveal]),
  };
}
