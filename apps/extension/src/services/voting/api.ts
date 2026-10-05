/**
 * Zcash coinholder voting - read-only API, functional style.
 *
 * No classes, no shared mutable state: every function takes its inputs
 * and returns data. Failover across vote servers is a fold over the
 * endpoint list. Callers (react-query) own caching and retries.
 *
 * Trust model:
 *   - the config (trusted keys, vote servers, pir endpoints, endorsed round
 *     keys) ships bundled with the release (./bundled-config.ts)
 *   - a round's election-authority key (ea_pk) comes ONLY from that config,
 *     and only when a bundled trusted key signed it for the round
 *     (./round-auth.ts). A vote server's copy must match it or the round
 *     cannot be voted on.
 *   - the snapshot roots a delegation proves against (nc_root,
 *     nullifier_imt_root) are not signed anywhere, so casting takes them
 *     only when at least two vote servers agree (fetchRoundParams).
 *   - submissions never fail over in a way that could report an accepted
 *     vote as rejected (postVoteTx).
 */

import { requestEgressOptIn } from '../../net/egress-opt-in';
import { BUNDLED_SERVICE_CONFIG, BUNDLED_STATIC_CONFIG } from './bundled-config';
import { endorsedEaPkHex } from './round-auth';
import type {
  StaticVotingConfig,
  TallyResults,
  VotingRound,
  VotingServiceConfig,
  RoundStatus,
} from './types';

const ROUNDS_PATH = '/shielded-vote/v1/rounds';
const tallyPath = (roundIdHex: string) => `/shielded-vote/v1/tally-results/${roundIdHex}`;

const FETCH_TIMEOUT_MS = 10_000;
/**
 * A vote server answers a POST only after CheckTx, which verifies the
 * submission's proof and signature (~10s for a delegation on a fast node).
 */
const POST_TIMEOUT_MS = 90_000;

const getJson = async <T>(url: string): Promise<T> => {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
  }
  return resp.json() as Promise<T>;
};

/**
 * Try each base url in order until one answers; surface the last error
 * if all fail. Vote servers are interchangeable replicas per config.
 */
const firstReachable = async <T>(
  baseUrls: readonly string[],
  call: (baseUrl: string) => Promise<T>,
): Promise<T> => {
  let lastError: unknown = new Error('no vote servers configured');
  for (const base of baseUrls) {
    try {
      return await call(base.replace(/\/$/, ''));
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/**
 * Who runs a vote server, as far as the config can tell: the registrable
 * domain of its URL (the last two labels; an IP or single-label host stands
 * for itself). Two hosts under one domain - the two `*.sslip.io` entries,
 * say - count as one operator for every "independent servers agree" check.
 */
export const operatorOf = (url: string): string => {
  const host = new URL(url).hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) {
    return host;
  }
  return host.split('.').slice(-2).join('.');
};

const serverBases = (config: VotingServiceConfig): string[] => [
  ...new Set(config.vote_servers.map(s => s.url.replace(/\/$/, ''))),
];

/* wire DTO → domain --------------------------------------------------- */

interface ChainRoundDto {
  vote_round_id: string;
  /** base64 32 bytes: the round's election-authority key, set once its ceremony confirms */
  ea_pk?: string;
  /** base64 32 bytes: note-commitment tree root at the snapshot */
  nc_root?: string;
  /** base64 32 bytes: nullifier IMT root at the snapshot */
  nullifier_imt_root?: string;
  title?: string;
  description?: string;
  snapshot_height: number;
  vote_end_time: number;
  ceremony_phase_start?: number;
  status?: number;
  discussion_url?: string | null;
  proposals?: {
    id: number;
    title?: string;
    description?: string;
    // `index` is the option's position (0 is omitted on the wire); older
    // server builds sent `id`.
    options?: { index?: number; id?: number; label?: string }[];
    zip_number?: string | null;
    forum_url?: string | null;
  }[];
}

// vote-sdk SessionStatus: 4 = PENDING (the round's key ceremony is still
// running, it opens once that confirms); 5 = CEREMONY_FAILED falls through to
// 'cancelled'. Neither can take votes yet.
const STATUS_BY_CODE: Record<number, RoundStatus> = {
  1: 'active',
  2: 'tallying',
  3: 'completed',
  4: 'starting',
};

/**
 * base64 (any padding) to lowercase hex; undefined for a missing or
 * malformed field, or one that is not exactly `bytes` long.
 */
const b64ToHex = (raw: string | undefined, bytes: number): string | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    const decoded = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    if (decoded.length !== bytes) {
      return undefined;
    }
    return Array.from(decoded, b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
};

/** Round ids arrive as hex or base64 depending on server build; normalize to lowercase hex. */
const normalizeRoundId = (raw: string): string => {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return raw.toLowerCase();
  }
  try {
    const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return raw.toLowerCase();
  }
};

/**
 * The round's ea_pk only when the bundled config endorses it and the server
 * (if it reports one yet) agrees. A server with another key gets none: no
 * vote can be built for that round from here.
 */
const trustedEaPkHex = (
  trust: StaticVotingConfig,
  config: VotingServiceConfig,
  id: string,
  chainEaPk: string | undefined,
): string | undefined => {
  const endorsed = endorsedEaPkHex(trust, config, id);
  if (!endorsed || (chainEaPk !== undefined && b64ToHex(chainEaPk, 32) !== endorsed)) {
    return undefined;
  }
  return endorsed;
};

const toRound = (
  dto: ChainRoundDto,
  config: VotingServiceConfig,
  trust: StaticVotingConfig,
): VotingRound => {
  const id = normalizeRoundId(dto.vote_round_id);
  return {
    id,
    title: dto.title ?? '',
    description: dto.description ?? '',
    discussionUrl: dto.discussion_url ?? undefined,
    // Coalesce numeric fields to finite numbers - the server may omit or send
    // them non-numeric, and the render path feeds them to Date/.toLocaleString
    // which throw on NaN/undefined.
    snapshotHeight: Number.isFinite(dto.snapshot_height) ? dto.snapshot_height : 0,
    votingStart:
      typeof dto.ceremony_phase_start === 'number' && Number.isFinite(dto.ceremony_phase_start)
        ? dto.ceremony_phase_start
        : 0,
    votingEnd: Number.isFinite(dto.vote_end_time) ? dto.vote_end_time : 0,
    status: STATUS_BY_CODE[dto.status ?? 1] ?? 'cancelled',
    eaPkHex: trustedEaPkHex(trust, config, id, dto.ea_pk),
    proposals: (dto.proposals ?? []).map(p => ({
      id: p.id,
      title: p.title ?? '',
      description: p.description ?? '',
      // The tally keys each weight by `vote_decision`, a 0-based index into
      // this options array, and a cast's `choice` is the same index. The
      // server sends it as `index` with 0 omitted (proto3 default), so an
      // option without one is index 0 only when it is first; fall back to the
      // array position, which is what the index is.
      options: (p.options ?? []).map((o, i) => {
        const id = o.index ?? o.id ?? i;
        return { id, label: o.label ?? `option ${id}` };
      }),
      zipNumber: p.zip_number ?? undefined,
      forumUrl: p.forum_url ?? undefined,
    })),
    inConfig: id in config.rounds,
    isTest: isTestRound(dto.title ?? ''),
  };
};

/**
 * A round the ceremony operator titled `[TEST]` (case-insensitive, leading
 * token). These are dry-run rounds that share the same vote server as the real
 * coinholder votes; the `[TEST]` prefix is the operator's own marker, the only
 * thing that distinguishes them at the wire level. They are tagged (not
 * dropped) so the UI can hide them by default but offer a toggle to reveal.
 */
const isTestRound = (title: string): boolean => /^\s*\[test\]/i.test(title);

/** Fetch all rounds from the first reachable vote server (test rounds tagged). */
export const fetchRounds = async (
  config: VotingServiceConfig,
  trust: StaticVotingConfig = BUNDLED_STATIC_CONFIG,
): Promise<VotingRound[]> => {
  const resp = await firstReachable(
    config.vote_servers.map(s => s.url),
    base => getJson<{ rounds?: ChainRoundDto[] }>(`${base}${ROUNDS_PATH}`),
  );
  return (resp.rounds ?? [])
    .map(dto => toRound(dto, config, trust))
    .sort((a, b) => b.votingEnd - a.votingEnd);
};

/** Everything a delegation and its casts are built against. */
export interface RoundParams {
  /** 64-char lowercase hex */
  voteRoundId: string;
  snapshotHeight: number;
  eaPkHex: string;
  ncRootHex: string;
  nullifierImtRootHex: string;
}

/** `round_params_json` for build_delegation_pczt / cast_vote_hot_wire. */
export const roundParamsJson = (p: RoundParams): string =>
  JSON.stringify({
    vote_round_id: p.voteRoundId,
    snapshot_height: p.snapshotHeight,
    ea_pk_hex: p.eaPkHex,
    nc_root_hex: p.ncRootHex,
    nullifier_imt_root_hex: p.nullifierImtRootHex,
  });

/**
 * The round's parameters, fit to build a delegation and casts on.
 *
 * `ea_pk` comes from the bundled endorsement only (see ./round-auth.ts). The
 * snapshot height and roots are unsigned, so they are read from servers of
 * `quorum` distinct operators (see `operatorOf`) and must agree exactly; any server that answers with
 * other values, or with an ea_pk other than the endorsed one, stops it. A
 * config with fewer reachable operators than `quorum` cannot cast.
 */
export const fetchRoundParams = async (
  config: VotingServiceConfig,
  roundIdHex: string,
  { trust = BUNDLED_STATIC_CONFIG, quorum = 2 } = {},
): Promise<RoundParams> => {
  const id = roundIdHex.toLowerCase();
  const eaPkHex = endorsedEaPkHex(trust, config, id);
  if (!eaPkHex) {
    throw new Error(`round ${id} has no endorsed election key in this zafu build`);
  }
  let agreed: RoundParams | undefined;
  const operators = new Set<string>();
  for (const base of serverBases(config)) {
    let dto: ChainRoundDto;
    try {
      const body = await getJson<{ round?: ChainRoundDto } & ChainRoundDto>(
        `${base}/shielded-vote/v1/round/${id}`,
      );
      dto = body.round ?? body;
    } catch {
      continue;
    }
    const answer: RoundParams | undefined = (() => {
      const ncRootHex = b64ToHex(dto.nc_root, 32);
      const nullifierImtRootHex = b64ToHex(dto.nullifier_imt_root, 32);
      if (
        normalizeRoundId(dto.vote_round_id ?? '') !== id ||
        !Number.isSafeInteger(dto.snapshot_height) ||
        !ncRootHex ||
        !nullifierImtRootHex
      ) {
        return undefined;
      }
      return {
        voteRoundId: id,
        snapshotHeight: dto.snapshot_height,
        eaPkHex,
        ncRootHex,
        nullifierImtRootHex,
      };
    })();
    if (!answer) {
      continue;
    }
    if (dto.ea_pk !== undefined && b64ToHex(dto.ea_pk, 32) !== eaPkHex) {
      throw new Error(`${new URL(base).host} reports another election key for round ${id}`);
    }
    if (
      agreed &&
      (agreed.snapshotHeight !== answer.snapshotHeight ||
        agreed.ncRootHex !== answer.ncRootHex ||
        agreed.nullifierImtRootHex !== answer.nullifierImtRootHex)
    ) {
      throw new Error(`vote servers disagree on round ${id}'s snapshot`);
    }
    agreed = answer;
    operators.add(operatorOf(base));
    if (operators.size >= quorum) {
      return agreed;
    }
  }
  throw new Error(
    `round ${id}: ${operators.size} of the ${quorum} independent vote-server operators ` +
      'needed to confirm its snapshot answered',
  );
};

/** Fetch tally results for one round. Weights are relative; render as shares. */
export const fetchTally = async (
  config: VotingServiceConfig,
  roundIdHex: string,
): Promise<TallyResults> => {
  const resp = await firstReachable(
    config.vote_servers.map(s => s.url),
    base =>
      getJson<{
        results?: { proposal_id: number; vote_decision?: number; total_value?: number }[];
      }>(`${base}${tallyPath(roundIdHex)}`),
  );
  const byProposal = new Map<number, { optionId: number; weight: number }[]>();
  for (const r of resp.results ?? []) {
    const list = byProposal.get(r.proposal_id) ?? [];
    list.push({ optionId: r.vote_decision ?? 0, weight: r.total_value ?? 0 });
    byProposal.set(r.proposal_id, list);
  }
  return {
    roundId: roundIdHex,
    proposals: Array.from(byProposal, ([proposalId, options]) => ({ proposalId, options })),
  };
};

/** One-call composition for the UI: the bundled config's vote servers → rounds. */
export const loadVoting = async () => {
  // optional destination: ask first; a no leaves the fetch below to refuse.
  // the config itself is bundled (see ./bundled-config.ts) - only the vote
  // servers it names are actually contacted, never github.
  await requestEgressOptIn('voting');
  const config = BUNDLED_SERVICE_CONFIG;
  const rounds = await fetchRounds(config);
  return { config, rounds };
};

/* submissions ---------------------------------------------------------- */

/**
 * Outcome of a vote-chain transaction POST. `rejected` is set only when the
 * chain or server definitely refused it; `unknown` when it may have landed
 * (look it up by `txHash`, or by its leaf in the commitment tree, before
 * building or sending it again).
 */
export interface VoteTxResult {
  ok: boolean;
  status: number;
  message: string;
  txHash?: string;
  rejected?: boolean;
  unknown?: boolean;
  /** the operator (see `operatorOf`) whose answer this is */
  operator?: string;
  /** a refusal two independent operators agree on */
  confirmed?: boolean;
}

/** Same shape for each submission kind. */
export type DelegationSubmissionResult = VoteTxResult;
export type VoteCastResult = VoteTxResult;

const TX_HASH_RE = /^[0-9A-Fa-f]{64}$/;

/** The tx hash a vote server reports: `tx_hash` in the body, or in an error message. */
const txHashOf = (body: unknown): string | undefined => {
  const b = (body ?? {}) as { tx_hash?: unknown; error?: unknown; message?: unknown };
  if (typeof b.tx_hash === 'string' && TX_HASH_RE.test(b.tx_hash)) {
    return b.tx_hash.toUpperCase();
  }
  const text = [b.error, b.message].find(v => typeof v === 'string');
  return text?.match(/tx_hash=([0-9A-Fa-f]{64})/)?.[1]?.toUpperCase();
};

const messageOf = (body: unknown, fallback: string): string => {
  const b = (body ?? {}) as { log?: unknown; error?: unknown; message?: unknown };
  const m = [b.log, b.error, b.message].find(v => typeof v === 'string' && v) as string | undefined;
  return m ?? fallback;
};

const isTimeout = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** A tx's state on the vote chain, from `GET /tx/{hash}`. */
export type TxLookup =
  | { state: 'pending' }
  | { state: 'included'; height: number; events: TxEvent[]; operator: string }
  | { state: 'failed'; height: number; code: number; log: string; operator: string };

export interface TxEvent {
  type: string;
  attributes: { key: string; value: string }[];
}

/**
 * Look a tx up by hash. A 404 from one server is not taken as "pending":
 * the next server is asked, and the tx is pending only when every server
 * that answers says so. `exclude` skips one operator's servers (to get a
 * second opinion). GETs are safe to retry, so this fails over freely.
 */
export const lookupTx = async (
  config: VotingServiceConfig,
  txHash: string,
  { exclude }: { exclude?: readonly string[] } = {},
): Promise<TxLookup> => {
  let answered = false;
  let last: unknown = new Error('no vote servers to ask');
  for (const base of serverBases(config)) {
    const operator = operatorOf(base);
    if (exclude?.includes(operator)) {
      continue;
    }
    try {
      const resp = await fetch(`${base}/shielded-vote/v1/tx/${txHash}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.status === 404) {
        answered = true;
        continue;
      }
      if (!resp.ok && resp.status !== 422) {
        throw new Error(`HTTP ${resp.status} from ${new URL(base).host}`);
      }
      const body = (await resp.json()) as {
        height?: string | number;
        code?: number;
        log?: string;
        events?: TxEvent[];
      };
      const height = Number(body.height);
      if (!Number.isSafeInteger(height)) {
        throw new Error(`tx ${txHash}: no height from ${new URL(base).host}`);
      }
      if (resp.status === 422 || (body.code ?? 0) !== 0) {
        return { state: 'failed', height, code: body.code ?? 0, log: body.log ?? '', operator };
      }
      return { state: 'included', height, events: body.events ?? [], operator };
    } catch (e) {
      last = e;
    }
  }
  if (answered) {
    return { state: 'pending' };
  }
  throw last instanceof Error ? last : new Error(String(last));
};

/** Settle an ambiguous submission by its hash: only an included tx is accepted. */
const settleByHash = async (
  config: VotingServiceConfig,
  txHash: string,
  status: number,
  message: string,
): Promise<VoteTxResult> => {
  try {
    const tx = await lookupTx(config, txHash);
    if (tx.state === 'included') {
      return { ok: true, status, message: 'included', txHash, operator: tx.operator };
    }
    if (tx.state === 'failed') {
      return {
        ok: false,
        status,
        message: tx.log || message,
        txHash,
        rejected: true,
        operator: tx.operator,
      };
    }
  } catch {
    // unreachable: the outcome stays unknown
  }
  return { ok: false, status, message, txHash, unknown: true };
};

/**
 * POST one signed vote-chain transaction (delegate-vote / cast-vote).
 *
 * The same body is one transaction whichever server relays it, and a vote
 * server only answers after CheckTx. So:
 *   - a timeout or 504 is never retried elsewhere: the first server may have
 *     broadcast it, and a second copy is refused as a double spend, which
 *     would read as a rejected vote. It returns `unknown`.
 *   - 400 (request validation) and 422 (CheckTx refused) are final.
 *   - a dropped connection, 5xx or unknown route moves to the next server;
 *     after a dropped connection, a later refusal is settled by looking its
 *     tx hash up instead of being reported as rejected.
 *   - any reported tx hash is looked up before a 5xx counts as failed.
 *
 * `mayBeOnChain`: this body was sent before with an unknown outcome. The
 * server's mempool cache answers a repeat with the tx hash; once the tx is in
 * a block a repeat is refused as a double spend, and that refusal is settled
 * by its hash (the same body is the same tx) instead of reported.
 */
export const postVoteTx = async (
  config: VotingServiceConfig,
  path: string,
  bodyJson: string,
  { mayBeOnChain = false } = {},
): Promise<VoteTxResult> => {
  let ambiguous = mayBeOnChain;
  let last = 'no vote servers configured';
  for (const base of config.vote_servers.map(s => s.url.replace(/\/$/, ''))) {
    const operator = operatorOf(base);
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (e) {
      if (isTimeout(e)) {
        return {
          ok: false,
          status: 0,
          message: `${new URL(base).host} did not answer in time; it may still have been accepted`,
          unknown: true,
        };
      }
      // the request may have reached the server before the connection dropped
      ambiguous = true;
      last = e instanceof Error ? e.message : String(e);
      continue;
    }
    const body: unknown = await resp.json().catch(() => undefined);
    const txHash = txHashOf(body);
    if (resp.ok) {
      return { ok: true, status: resp.status, message: 'accepted', txHash, operator };
    }
    if (resp.status === 400) {
      return {
        ok: false,
        status: 400,
        message: messageOf(body, 'refused'),
        txHash,
        rejected: true,
        operator,
      };
    }
    if (resp.status === 422) {
      const message = messageOf(body, 'refused');
      if (ambiguous) {
        return txHash
          ? settleByHash(config, txHash, 422, message)
          : { ok: false, status: 422, message, unknown: true };
      }
      return { ok: false, status: 422, message, txHash, rejected: true, operator };
    }
    if (resp.status === 504) {
      return txHash
        ? settleByHash(config, txHash, 504, messageOf(body, 'gateway timeout'))
        : { ok: false, status: 504, message: 'gateway timeout', unknown: true };
    }
    if (txHash) {
      return settleByHash(config, txHash, resp.status, messageOf(body, `HTTP ${resp.status}`));
    }
    if (resp.status >= 500) {
      ambiguous = true;
    }
    last = `HTTP ${resp.status} from ${new URL(base).host}`;
  }
  return ambiguous
    ? { ok: false, status: 0, message: last, unknown: true }
    : { ok: false, status: 0, message: last };
};

/**
 * A second, independent opinion on a refusal. One operator's 400/422 or
 * failed /tx is never enough to give a vote up: it could be wrong, or lie.
 *
 * Asks only servers of operators not in `refusedBy`: first by tx hash (an
 * included tx means the vote stands), then by sending the identical body.
 * The refusal is `confirmed` only when another operator refuses it too and
 * no server holds the tx in a block. An acceptance elsewhere comes back `ok`.
 * When no other operator answers, it stays an unconfirmed refusal.
 */
export const confirmRefusal = async (
  config: VotingServiceConfig,
  path: string,
  bodyJson: string,
  refused: VoteTxResult,
  refusedBy: readonly string[],
): Promise<VoteTxResult> => {
  const others: VotingServiceConfig = {
    ...config,
    vote_servers: config.vote_servers.filter(s => !refusedBy.includes(operatorOf(s.url))),
  };
  if (!others.vote_servers.length) {
    return { ...refused, confirmed: false };
  }
  if (refused.txHash) {
    const tx = await lookupTx(others, refused.txHash).catch(() => undefined);
    if (tx?.state === 'included') {
      return {
        ok: true,
        status: 200,
        message: 'included',
        txHash: refused.txHash,
        operator: tx.operator,
      };
    }
    if (tx?.state === 'failed') {
      return {
        ...refused,
        message: tx.log || refused.message,
        operator: tx.operator,
        confirmed: true,
      };
    }
  }
  const again = await postVoteTx(others, path, bodyJson);
  if (again.ok || !again.rejected) {
    return again;
  }
  // refused twice; still make sure it is not in a block under its hash
  const hash = again.txHash ?? refused.txHash;
  if (hash) {
    const tx = await lookupTx(others, hash).catch(() => undefined);
    if (tx?.state === 'included') {
      return { ok: true, status: 200, message: 'included', txHash: hash, operator: tx.operator };
    }
  }
  return { ...again, confirmed: true };
};

/**
 * Submit a delegation (MsgDelegateVote; finalize_delegation's wire JSON).
 * Store the delegation state only once this is accepted and included.
 */
export const submitDelegation = async (
  config: VotingServiceConfig,
  delegationWireJson: string,
): Promise<DelegationSubmissionResult> => {
  const res = await postVoteTx(config, '/shielded-vote/v1/delegate-vote', delegationWireJson);
  // A chain past TX1 effects v1 (V6 / NU6.3) refuses this build's encoding.
  if (/unsupported tx1 effects version/i.test(res.message)) {
    return {
      ...res,
      message:
        'the vote chain now expects a newer delegation format than this version of zafu ' +
        'signs (TX1 effects v1, V6 / NU6.3). we are sorry; an update to zafu is needed to ' +
        'delegate in this round.',
    };
  }
  return res;
};

/**
 * Submit a vote (MsgCastVote; cast_vote_hot_wire's `wire`). Pass
 * `mayBeOnChain` when re-sending a wire whose first send had an unknown
 * outcome.
 */
export const castVote = async (
  config: VotingServiceConfig,
  voteWireJson: string,
  opts: { mayBeOnChain?: boolean } = {},
): Promise<VoteCastResult> => postVoteTx(config, '/shielded-vote/v1/cast-vote', voteWireJson, opts);

/** Where an included cast landed in the round's vote commitment tree. */
export interface CastPosition {
  height: number;
  /** the vote commitment's leaf index: what helper shares commit to */
  vcPosition: number;
  /** the new vote-authority note's leaf index: the next cast's VAN witness */
  vanPosition: number;
}

const b64Bytes = (raw: string): string | undefined => b64ToHex(raw, 32);

/**
 * Find where a cast landed: wait for its tx to be included, read the
 * `cast_vote` event's `leaf_index` ("van,vc"; CometBFT 0.38 sends event
 * attributes as plain strings), and check against the tree's own leaves for
 * that block that the vote commitment is at that index.
 */
export const castPosition = async (
  config: VotingServiceConfig,
  roundIdHex: string,
  txHash: string,
  voteCommitmentB64: string,
  { attempts = 60, intervalMs = 2_000 } = {},
): Promise<CastPosition> => {
  let tx: TxLookup = { state: 'pending' };
  for (let i = 0; i < attempts && tx.state === 'pending'; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, intervalMs));
    }
    tx = await lookupTx(config, txHash).catch((): TxLookup => ({ state: 'pending' }));
  }
  if (tx.state === 'pending') {
    throw new Error(`cast tx ${txHash} is not in a block yet`);
  }
  if (tx.state === 'failed') {
    throw new Error(`cast tx ${txHash} failed on chain: ${tx.log || `code ${tx.code}`}`);
  }
  const leafIndex = tx.events
    .filter(e => e.type === 'cast_vote')
    .flatMap(e => e.attributes)
    .find(a => a.key === 'leaf_index');
  const [van, vc] = (leafIndex?.value ?? '').split(',').map(Number);
  if (!Number.isSafeInteger(van) || !Number.isSafeInteger(vc)) {
    throw new Error(`cast tx ${txHash} carries no leaf_index`);
  }
  const height = tx.height;
  const page = await firstReachable(
    config.vote_servers.map(s => s.url),
    base =>
      getJson<{ blocks?: { height: number; start_index: number; leaves?: string[] }[] }>(
        `${base}/shielded-vote/v1/commitment-tree/${roundIdHex}/leaves?from_height=${height}&to_height=${height}`,
      ),
  );
  const block = page.blocks?.find(b => Number(b.height) === height);
  const leaf = block?.leaves?.[vc! - Number(block.start_index)];
  if (!leaf || b64Bytes(leaf) !== b64Bytes(voteCommitmentB64)) {
    throw new Error(`the commitment tree does not hold this vote at index ${vc}`);
  }
  return { height, vcPosition: vc!, vanPosition: van! };
};

/** Result of handing one encrypted share to a helper. */
export interface ShareSubmissionResult {
  ok: boolean;
  status: number;
  message: string;
}

/**
 * Hand one helper share (an element of build_vote_shares_from_recovery's
 * output) to the helper on one vote server. The helper takes exactly one
 * share object per request.
 */
export const submitShare = async (
  helperBaseUrl: string,
  shareJson: string,
): Promise<ShareSubmissionResult> => {
  let share: unknown;
  try {
    share = JSON.parse(shareJson);
  } catch {
    return { ok: false, status: 0, message: 'share is not JSON' };
  }
  if (typeof share !== 'object' || share === null || Array.isArray(share)) {
    return { ok: false, status: 0, message: 'one share object per request' };
  }
  try {
    const resp = await fetch(`${helperBaseUrl.replace(/\/$/, '')}/shielded-vote/v1/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: shareJson,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.ok) {
      return { ok: true, status: resp.status, message: 'share queued' };
    }
    let message = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string };
      message = body.error || message;
    } catch {
      // ignore parse errors
    }
    return { ok: false, status: resp.status, message };
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
};

/** Cryptographically shuffled copy (Fisher-Yates over getRandomValues). */
const shuffled = <T>(items: readonly T[]): T[] => {
  const out = [...items];
  const rand = new Uint32Array(out.length);
  crypto.getRandomValues(rand);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand[i]! % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

/**
 * Send each share (build_vote_shares_from_recovery's array) to half the
 * helpers, rounded up, picked at random per share, one share per request
 * (zcash_voting's `share_submission_target_count`). Resolves to the
 * share_index of every share at least one helper queued.
 *
 * Shares in `skip` (already queued by a helper) are not sent again. vote-sdk
 * helpers do take an identical re-send (`"status": "duplicate"`, keyed on
 * round, share index, proposal and tree position), but a re-send would go to
 * a new random set of helpers and widen who holds that share, and a changed
 * `submit_at` is a 409 conflict. So only the missing ones go out.
 */
export const submitShares = async (
  config: VotingServiceConfig,
  sharesJson: string,
  { skip = [] }: { skip?: readonly number[] } = {},
): Promise<{ total: number; queued: number[]; errors: string[] }> => {
  const shares = JSON.parse(sharesJson) as { share_index: number }[];
  const helpers = serverBases(config);
  const perShare = Math.ceil(helpers.length / 2);
  const errors: string[] = [];
  const queued = await Promise.all(
    shares.map(async share => {
      if (skip.includes(share.share_index)) {
        return share.share_index;
      }
      const body = JSON.stringify(share);
      const sent = await Promise.all(
        shuffled(helpers)
          .slice(0, perShare)
          .map(h => submitShare(h, body)),
      );
      sent.filter(r => !r.ok).forEach(r => errors.push(r.message));
      return sent.some(r => r.ok) ? share.share_index : undefined;
    }),
  );
  return {
    total: shares.length,
    queued: queued.filter((i): i is number => i !== undefined),
    errors,
  };
};
