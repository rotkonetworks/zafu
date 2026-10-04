/**
 * Zcash coinholder voting - wire types.
 *
 * Protocol: Valar/ZODL token-holder voting, as shipped in Zashi.
 * The config (trusted keys, vote servers, pir endpoints, per-round
 * authenticator signatures) rarely changes and ships bundled with the
 * release (see ./bundled-config.ts) instead of being fetched from github at
 * run time. Only the vote servers themselves are contacted live:
 *   vote servers: /shielded-vote/v1/rounds, /tally-results/{id}
 *
 * This module is read-only (phase 1): list rounds, show proposals,
 * show tallies. Casting requires the voting crypto crate (note-bundle
 * setup, hotkeys, nullifier proofs) compiled into zcash-wasm - phase 2.
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
  pir_layout?: {
    pir_depth: number;
    tier0_layers: number;
    tier1_layers: number;
    poly_len: number;
  };
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
  /** election-authority key (hex), present once the round's key ceremony confirmed */
  eaPkHex?: string;
  /** note-commitment tree root at the snapshot (hex); delegation proves against it */
  ncRootHex?: string;
  /** nullifier IMT root at the snapshot (hex); delegation proves against it */
  nullifierImtRootHex?: string;
  proposals: VotingProposal[];
  /** present in the pinned dynamic config's rounds map (basic endorsement) */
  inConfig: boolean;
  /** operator dry-run round (title prefixed "[TEST]"); hidden unless the user
      opts to show them. */
  isTest: boolean;
}

export interface OptionTally {
  optionId: number;
  /**
   * Raw `total_value` from the tally server: a count of 0.125-zec ballots,
   * not zec and not zatoshi (`zcash_voting::governance::BALLOT_DIVISOR` =
   * 12,500,000 zatoshi per ballot - confirmed against valargroup's own
   * reference UI, which renders finalized `total_value` the same way).
   * Convert with the vote screen's `ballotsToZec` before showing it as zec.
   */
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
