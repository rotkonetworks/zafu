/**
 * Zcash coinholder voting — read-only API, functional style.
 *
 * No classes, no shared mutable state: every function takes its inputs
 * and returns data. Failover across vote servers is a fold over the
 * endpoint list. Callers (react-query) own caching and retries.
 *
 * Trust model for phase 1 (read-only):
 *   - the static config is integrity-pinned (commit-locked URL + sha256)
 *   - rounds are cross-checked against the pinned dynamic config's
 *     rounds map (`inConfig`); unlisted rounds render with a warning
 *   - per-round ed25519 authenticator signatures are NOT yet verified —
 *     that lands with the phase-2 cast flow where it actually gates
 *     spending-adjacent actions. Display-only data is bounded by the
 *     pinned config's server list.
 */

import type {
  PinnedConfigSource,
  StaticVotingConfig,
  TallyResults,
  VotingRound,
  VotingServiceConfig,
  RoundStatus,
} from './types';

const ROUNDS_PATH = '/shielded-vote/v1/rounds';
const tallyPath = (roundIdHex: string) => `/shielded-vote/v1/tally-results/${roundIdHex}`;

const FETCH_TIMEOUT_MS = 10_000;

const sha256Hex = async (data: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};

const getJson = async <T>(url: string): Promise<T> => {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
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

/** Fetch + checksum-verify the pinned static config. */
export const fetchStaticConfig = async (
  source: PinnedConfigSource,
): Promise<StaticVotingConfig> => {
  const resp = await fetch(source.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`static voting config: HTTP ${resp.status}`);
  const body = await resp.arrayBuffer();

  if (source.sha256) {
    const actual = await sha256Hex(body);
    if (actual !== source.sha256) {
      throw new Error(`static voting config checksum mismatch (got ${actual.slice(0, 12)}…)`);
    }
  }

  const cfg = JSON.parse(new TextDecoder().decode(body)) as StaticVotingConfig;
  if (cfg.static_config_version !== 1) {
    throw new Error(`unsupported static_config_version ${cfg.static_config_version}`);
  }
  if (!cfg.dynamic_config_url?.startsWith('https://')) {
    throw new Error('static voting config: dynamic_config_url must be https');
  }
  if (!cfg.trusted_keys?.length) {
    throw new Error('static voting config: trusted_keys empty');
  }
  return cfg;
};

/** Fetch the dynamic service config the static config points at. */
export const fetchServiceConfig = async (
  staticConfig: StaticVotingConfig,
): Promise<VotingServiceConfig> => {
  const cfg = await getJson<VotingServiceConfig>(staticConfig.dynamic_config_url);
  if (cfg.config_version !== 1) {
    throw new Error(`unsupported voting config_version ${cfg.config_version}`);
  }
  if (!cfg.vote_servers?.length) {
    throw new Error('voting config: vote_servers empty');
  }
  return cfg;
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
  proposals?: Array<{
    id: number;
    title?: string;
    description?: string;
    options?: Array<{ id: number; label?: string }>;
    zip_number?: string | null;
    forum_url?: string | null;
  }>;
}

const STATUS_BY_CODE: Record<number, RoundStatus> = {
  1: 'active',
  2: 'tallying',
  3: 'completed',
};

/** Round ids arrive as hex or base64 depending on server build; normalize to lowercase hex. */
const normalizeRoundId = (raw: string): string => {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
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
    snapshotHeight: dto.snapshot_height,
    votingStart: dto.ceremony_phase_start ?? 0,
    votingEnd: dto.vote_end_time,
    status: STATUS_BY_CODE[dto.status ?? 1] ?? 'cancelled',
    proposals: (dto.proposals ?? []).map(p => ({
      id: p.id,
      title: p.title ?? '',
      description: p.description ?? '',
      options: (p.options ?? []).map(o => ({ id: o.id, label: o.label ?? `option ${o.id}` })),
      zipNumber: p.zip_number ?? undefined,
      forumUrl: p.forum_url ?? undefined,
    })),
    inConfig: configRoundIds.has(id),
  };
};

/** Fetch all rounds from the first reachable vote server. */
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
      getJson<{ results?: Array<{ proposal_id: number; vote_decision?: number; total_value?: number }> }>(
        `${base}${tallyPath(roundIdHex)}`,
      ),
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

/** One-call composition for the UI: pinned source → rounds. */
export const loadVoting = async (source: PinnedConfigSource) => {
  const staticConfig = await fetchStaticConfig(source);
  const config = await fetchServiceConfig(staticConfig);
  const rounds = await fetchRounds(config);
  return { config, rounds };
};
