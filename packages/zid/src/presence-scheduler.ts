/**
 * Fixed-cadence presence scheduler — enforces the traffic-analysis invariant.
 *
 * The blind relay hides your friend count only if writes are BOTH padded (see
 * ContactRelay) AND on a fixed cadence: exactly one publish per presence epoch,
 * UNCONDITIONALLY — even when you are idle or have zero present friends (that
 * still writes an all-dummy, constant-shape bucket). If publishes tracked user
 * activity instead, the relay operator would recover your online-timing pattern,
 * half-defeating the padding.
 *
 * This module owns only the "publish once per epoch" logic; it is driven by an
 * external timer (the extension ticks it from the blockSync alarm). `tick()` is
 * idempotent within an epoch, so over-ticking is harmless and a missed tick just
 * means that epoch's beacon is skipped (the relay TTL handles staleness).
 */

import { presenceEpoch } from './contact-discovery';
import type { PresenceService, DiscoveryPeer } from './presence-service';
import type { PresenceRecord } from './presence-blob';

/** what to publish this epoch: my presence record + the friends to beacon to.
 *  `null` = not armed (no active identity for this app) -> publish nothing. An
 *  EMPTY `peers` array is armed-but-friendless: still publishes an all-dummy
 *  bucket, preserving the fixed cadence. */
export type PublishArgs = { record: PresenceRecord; peers: readonly DiscoveryPeer[] } | null;

export interface PresenceSchedulerDeps {
  /** injectable clock (unix seconds). Default: Date.now()/1000. */
  nowSeconds?: () => number;
}

export interface PresenceScheduler {
  /** Publish this epoch's beacon if not already done. Safe to call repeatedly. */
  tick(): Promise<{ published: boolean; epoch: number }>;
  /** the last epoch actually published (for tests / diagnostics). */
  readonly lastPublishedEpoch: number;
}

export const createPresenceScheduler = (
  service: PresenceService,
  getPublishArgs: () => PublishArgs,
  deps: PresenceSchedulerDeps = {},
): PresenceScheduler => {
  const nowSeconds = deps.nowSeconds ?? (() => Date.now() / 1000);
  let lastPublishedEpoch = -1;

  return {
    async tick() {
      const epoch = presenceEpoch(nowSeconds());
      if (epoch === lastPublishedEpoch) {
        return { published: false, epoch }; // already beaconed this epoch
      }
      const args = getPublishArgs();
      if (args === null) {
        return { published: false, epoch }; // not armed for this app
      }
      // Claim the epoch BEFORE the await so concurrent ticks don't double-publish.
      lastPublishedEpoch = epoch;
      // Empty peers still publishes an all-dummy bucket (fixed cadence).
      await service.publishSelf(args.record, args.peers, epoch);
      return { published: true, epoch };
    },
    get lastPublishedEpoch() {
      return lastPublishedEpoch;
    },
  };
};
