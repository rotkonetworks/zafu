/**
 * Zcash coinholder voting — wire types.
 *
 * Protocol: Valar/ZODL token-holder voting, as shipped in Zashi.
 * Config chain:
 *   pinned static config (sha256-checksummed github raw URL)
 *     → dynamic_config_url (vote servers, pir endpoints, per-round
 *       authenticator signatures)
 *       → vote servers: /shielded-vote/v1/rounds, /tally-results/{id}
 *
 * This module is read-only (phase 1): list rounds, show proposals,
 * show tallies. Casting requires the voting crypto crate (note-bundle
 * setup, hotkeys, nullifier proofs) compiled into zcash-wasm — phase 2.
 */

export interface TrustedKey {
  key_id: string;
  alg: string; // 'ed25519'
  pubkey: string; // base64, 32 bytes
  notes?: string;
}

export interface StaticVotingConfig {
  static_config_version: number;
  dynamic_config_url: string;
  trusted_keys: TrustedKey[];
}

export interface ServiceEndpoint {
  url: string;
  label: string;
}

export interface RoundConfigEntry {
  auth_version: number;
  ea_pk: string; // base64
  signatures: { key_id: string; alg: string; sig: string }[];
}

export interface VotingServiceConfig {
  config_version: number;
  vote_servers: ServiceEndpoint[];
  pir_endpoints: ServiceEndpoint[];
  supported_versions: {
    pir: string[];
    vote_protocol: string;
    tally: string;
    vote_server: string;
  };
  /** keyed by 64-char lowercase hex round id */
  rounds: Record<string, RoundConfigEntry>;
}

export type RoundStatus = 'active' | 'tallying' | 'completed' | 'cancelled';

export interface VoteOption {
  id: number;
  label: string;
}

export interface VotingProposal {
  id: number;
  title: string;
  description: string;
  options: VoteOption[];
  zipNumber?: string;
  forumUrl?: string;
}

export interface VotingRound {
  /** 64-char lowercase hex */
  id: string;
  title: string;
  description: string;
  discussionUrl?: string;
  snapshotHeight: number;
  /** unix seconds */
  votingStart: number;
  /** unix seconds */
  votingEnd: number;
  status: RoundStatus;
  proposals: VotingProposal[];
  /** present in the pinned dynamic config's rounds map (basic endorsement) */
  inConfig: boolean;
}

export interface OptionTally {
  optionId: number;
  /** raw total_value from the tally server (relative weight) */
  weight: number;
}

export interface ProposalTally {
  proposalId: number;
  options: OptionTally[];
}

export interface TallyResults {
  roundId: string;
  proposals: ProposalTally[];
}

/**
 * Pinned source for the static config. Mirrors Zashi's bundled pin:
 * commit-locked github raw URL + sha256 of the payload.
 */
export interface PinnedConfigSource {
  url: string;
  /** lowercase hex sha256 of the response body; null disables the check */
  sha256: string | null;
}

/** Same pin Zashi ships (valargroup/token-holder-voting-config @ 2785311). */
export const BUNDLED_PINNED_SOURCE: PinnedConfigSource = {
  url:
    'https://raw.githubusercontent.com/valargroup/token-holder-voting-config/' +
    '2785311d45758e85567d70a1f13709fa01b62c6b/prod/static-voting-config.json',
  sha256: 'bed0116f961226b256a574b52461ce81d9f5294a57e190987dc155f07eb1e431',
};
