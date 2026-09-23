import type * as FROM from '../versions/v2';
import type * as TO from '../versions/v3';
import { expectVersion, type Migration } from './util';

type MIGRATION = Migration<FROM.VERSION, FROM.LOCAL, TO.VERSION, TO.LOCAL>;

/**
 * v2 -> v3: additive schema bump for burner-address rotation.
 *
 *   - adds `cosmosChainCounters` (per-chainId HD index counter)
 *   - adds `cosmosFreshAddressRateLimits` (per-origin+chain 24 h counter)
 *
 * Both new fields are OPTIONAL. Existing keys are carried forward unchanged so
 * a wallet that never used rotation reads identically after the bump. There is
 * no data to transform - the migration is a pass-through that only advances
 * the version field.
 */
export default {
  version: v => expectVersion(v, 2, 3),
  transform: old => ({
    ...(old as TO.LOCAL),
    // required keys must be defined for the storage defaults to line up; the
    // required set is unchanged between v2 and v3, so we just re-emit them.
    penumbraWallets: old.penumbraWallets ?? [],
    knownSites: old.knownSites ?? [],
    numeraires: old.numeraires ?? [],
  }),
} satisfies MIGRATION;
