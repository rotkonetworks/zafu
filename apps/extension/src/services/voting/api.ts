/**
 * Zcash coinholder voting - read-only API, functional style.
 *
 * No classes, no shared mutable state: every function takes its inputs
 * and returns data. Failover across vote servers is a fold over the
 * endpoint list. Callers (react-query) own caching and retries.
 *
 * Trust model for phase 1 (read-only):
 *   - the config (trusted keys, vote servers, pir endpoints) ships bundled
 *     with the release (./bundled-config.ts) rather than being fetched
 *   - rounds are cross-checked against the bundled rounds map (`inConfig`);
 *     unlisted rounds render with a warning
 *   - per-round ed25519 authenticator signatures are NOT yet verified - *     that lands with the phase-2 cast flow where it actually gates
 *     spending-adjacent actions. Display-only data is bounded by the
 *     bundled config's server list.
 */

import { requestEgressOptIn } from '../../net/egress-opt-in';
import { BUNDLED_SERVICE_CONFIG } from './bundled-config';
import type { TallyResults, VotingRound, VotingServiceConfig, RoundStatus } from './types';

const ROUNDS_PATH = '/shielded-vote/v1/rounds';
const tallyPath = (roundIdHex: string) => `/shielded-vote/v1/tally-results/${roundIdHex}`;

const FETCH_TIMEOUT_MS = 10_000;

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

/* wire DTO → domain --------------------------------------------------- */

interface ChainRoundDto {
  vote_round_id: string;
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
    options?: { id?: number; label?: string }[];
    zip_number?: string | null;
    forum_url?: string | null;
  }[];
}

const STATUS_BY_CODE: Record<number, RoundStatus> = {
  1: 'active',
  2: 'tallying',
  3: 'completed',
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

const toRound = (dto: ChainRoundDto, configRoundIds: ReadonlySet<string>): VotingRound => {
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
    proposals: (dto.proposals ?? []).map(p => ({
      id: p.id,
      title: p.title ?? '',
      description: p.description ?? '',
      // The server ships option rows with a label but NO id (the whole options
      // array is positional), while the tally keys each weight by
      // `vote_decision` - a 0-based index into that same array (index 0 arrives
      // omitted on the wire, coalesced back to 0 in fetchTally). So the option
      // id MUST be its position, or the tally-to-option match in the UI finds
      // nothing and every bar renders 0%. Honour an explicit id if a future
      // server build sends one, else fall back to the index. Casting is
      // view-only today (phase 2), so nothing spends this id yet - it is a
      // render key only.
      options: (p.options ?? []).map((o, i) => ({
        id: o.id ?? i,
        label: o.label ?? `option ${o.id ?? i}`,
      })),
      zipNumber: p.zip_number ?? undefined,
      forumUrl: p.forum_url ?? undefined,
    })),
    inConfig: configRoundIds.has(id),
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
export const fetchRounds = async (config: VotingServiceConfig): Promise<VotingRound[]> => {
  const configRoundIds = new Set(Object.keys(config.rounds ?? {}).map(k => k.toLowerCase()));
  const resp = await firstReachable(
    config.vote_servers.map(s => s.url),
    base => getJson<{ rounds?: ChainRoundDto[] }>(`${base}${ROUNDS_PATH}`),
  );
  return (resp.rounds ?? [])
    .map(dto => toRound(dto, configRoundIds))
    .sort((a, b) => b.votingEnd - a.votingEnd);
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

/** Result of submitting delegation to a voting server. */
export interface DelegationSubmissionResult {
  ok: boolean;
  status: number;
  message: string;
  rejected?: boolean;
}

/** Submit a delegation wire to the voting service. */
export const submitDelegation = async (
  config: VotingServiceConfig,
  delegationWireJson: string,
): Promise<DelegationSubmissionResult> => {
  const delegationPath = '/shielded-vote/v1/delegations';
  try {
    return await firstReachable(
      config.vote_servers.map(s => s.url),
      async base => {
        const resp = await fetch(`${base.replace(/\/$/, '')}${delegationPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: delegationWireJson,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (resp.ok) {
          return { ok: true, status: resp.status, message: 'delegated' };
        }

        // 422 = rejected (deterministic, don't retry)
        if (resp.status === 422) {
          let message = 'delegation rejected';
          try {
            const body = (await resp.json()) as { error?: string; message?: string };
            message = body.error || body.message || message;
          } catch {
            // ignore parse errors
          }
          return { ok: false, status: 422, message, rejected: true };
        }

        throw new Error(`HTTP ${resp.status}`);
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message };
  }
};

/** Result of casting a vote. */
export interface VoteCastResult {
  ok: boolean;
  status: number;
  message: string;
  rejected?: boolean;
}

/** Submit a vote to the voting service. */
export const castVote = async (
  config: VotingServiceConfig,
  voteWireJson: string,
): Promise<VoteCastResult> => {
  const votePath = '/shielded-vote/v1/votes';
  try {
    return await firstReachable(
      config.vote_servers.map(s => s.url),
      async base => {
        const resp = await fetch(`${base.replace(/\/$/, '')}${votePath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: voteWireJson,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (resp.ok) {
          return { ok: true, status: resp.status, message: 'vote cast' };
        }

        // 422 = rejected (deterministic, don't retry)
        if (resp.status === 422) {
          let message = 'vote rejected';
          try {
            const body = (await resp.json()) as { error?: string; message?: string };
            message = body.error || body.message || message;
          } catch {
            // ignore parse errors
          }
          return { ok: false, status: 422, message, rejected: true };
        }

        throw new Error(`HTTP ${resp.status}`);
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message };
  }
};
