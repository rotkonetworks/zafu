/**
 * Bundled snapshot of the zcash coinholder voting config.
 *
 * The founder's call: this config "doesn't change that much", so it ships
 * with the release instead of being fetched over the network every time the
 * vote screen opens - that fetch used to go to raw.githubusercontent.com
 * before the user had asked for anything. `trusted_keys`, `vote_servers` and
 * `pir_endpoints` are the stable part. `rounds` (each round id's `ea_pk` and
 * endorsement signatures) genuinely changes as valargroup opens new rounds -
 * see the TODO below.
 *
 * Source (fetched 2026-10-01, both sha256-verified against the commits named):
 *   static:  https://raw.githubusercontent.com/valargroup/token-holder-voting-config/
 *            2785311d45758e85567d70a1f13709fa01b62c6b/prod/static-voting-config.json
 *            sha256 bed0116f961226b256a574b52461ce81d9f5294a57e190987dc155f07eb1e431
 *   dynamic: https://raw.githubusercontent.com/valargroup/token-holder-voting-config/
 *            eef477e28936f3e72bb3082670b64348ae4f0d3d/prod/dynamic-voting-config.json
 *            (resolved from the static config's dynamic_config_url, which tracks
 *            the repo's `main` branch - eef477e was its tip at fetch time)
 *            sha256 9716ca40771b253caa185e84b33d6487e78048664fcb4cb5f0f8ef11402aff81
 *
 * `rounds` (each round id's `ea_pk` and endorsement signatures) is bundled
 * too, as the endorsement cross-check. The vote servers' `/shielded-vote/v1/rounds`
 * now also return each round's `ea_pk`, `nc_root` and `nullifier_imt_root`
 * (vote-sdk 1.6, see api.ts's ChainRoundDto), so a round opened after this
 * build ships still has the keys casting needs; it lists with `inConfig:
 * false` until the bundled map is refreshed. Don't build a github fetch for it.
 */

import type { StaticVotingConfig, VotingServiceConfig } from './types';
import staticConfig from './static-voting-config.bundled.json';
import dynamicConfig from './dynamic-voting-config.bundled.json';

export const BUNDLED_STATIC_CONFIG = staticConfig satisfies StaticVotingConfig;
export const BUNDLED_SERVICE_CONFIG = dynamicConfig satisfies VotingServiceConfig;
