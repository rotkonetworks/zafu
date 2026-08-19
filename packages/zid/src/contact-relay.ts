/**
 * Blind-relay CLIENT for private contact discovery + its MANDATORY
 * traffic-analysis mitigation.
 *
 * The rendezvous-tag layer (`./contact-discovery`) lets two friends compute a
 * per-epoch tag with zero communication. This module publishes presence under
 * those tags to a DUMB key-value relay and finds friends' presence - WITHOUT
 * handing the relay operator the metadata needed to reconstruct the social
 * graph. The tag itself is already unlinkable across epochs; the danger that
 * remains is FLOW correlation - who publishes what, who fetches what - and the
 * two invariants below exist to close exactly that.
 *
 * ===========================================================================
 * INVARIANT 1 - BROADCAST-BUCKET READS (never a per-tag GET)
 * ===========================================================================
 * A naive client would GET each friend's expected tag individually. The relay
 * would then see "this fetcher asked for tags {t1,t2,...}", and by matching
 * those against the tags some publisher PUT, it could rebuild graph edges even
 * though every tag is opaque. So we NEVER read per-tag. Instead the relay
 * serves the epoch's FULL set of tags for an app-scope (a "bucket"); the client
 * downloads the whole bucket and matches its friends' expected tags LOCALLY.
 * The read access pattern is then identical for everyone and independent of who
 * your friends are or how many matched - "constant-time-ish" here means exactly
 * that: no per-friend network access, fetch shape independent of the match set
 * (not timing-safe byte compares - bucket contents are already public to you).
 *
 * ===========================================================================
 * INVARIANT 2 - PADDED FIXED-SIZE PUT BATCHES (constant F, fixed cadence)
 * ===========================================================================
 * A PUT of N tags would leak N = your friend count (and its changes over time).
 * So every publish emits a CONSTANT number F of entries per epoch per shard,
 * padding the real tags with dummy entries drawn uniformly at random. A dummy
 * tag is `RENDEZVOUS_TAG_BYTES` of randomness (real tags are HKDF output, i.e.
 * already uniform) and a dummy blob is `blobBytes` of randomness (real presence
 * blobs are AEAD ciphertext, indistinguishable from random) - so real and dummy
 * entries are byte-shape identical and the batch is shuffled so position leaks
 * nothing either. The cadence is fixed too: a publish with ZERO real friends
 * still emits F dummies, so "went quiet" is not observable. If real N would
 * exceed F we THROW rather than silently grow the batch (a size change is itself
 * a leak) - raise `padTo` deliberately instead.
 *
 * ===========================================================================
 * INVARIANT 3 (optional, DEFAULT OFF) - PREFIX SHARDING
 * ===========================================================================
 * Past ~1e4 users a single per-epoch bucket gets large. `shardPrefixBytes > 0`
 * shards the bucket by the tag's leading bytes so a client only writes/reads the
 * shards its friends fall in. This LEAKS which-prefix: the relay learns the
 * prefix-buckets you touch, a coarse fingerprint. A full mitigation would need
 * dummy-only PUTs/GETs across ALL shards, which defeats the point of sharding -
 * which is why this is an explicit opt-in, off by default. When on, dummies are
 * generated to carry the shard's own prefix so they stay indistinguishable from
 * reals WITHIN a shard.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { presenceEpoch, rendezvousTag, RENDEZVOUS_TAG_BYTES } from './contact-discovery';

// ---------------------------------------------------------------------------
// Wire model
// ---------------------------------------------------------------------------

/**
 * One published record: a rendezvous `tag` and its OPAQUE encrypted presence
 * `blob`. This module never inspects or produces the blob's plaintext - the
 * AEAD lives in `presence-blob.ts`; here a blob is just fixed-size bytes.
 */
export interface PresenceEntry {
  tag: Uint8Array;
  blob: Uint8Array;
}

/**
 * The relay transport, INJECTED so this client is network-agnostic and unit
 * testable. A conforming relay is a dumb key-value store keyed by
 * `(appScope, epoch, shard)`; it MUST return the whole bucket on read (that is
 * invariant 1 - it must not offer per-tag lookup). `shard` is '' when sharding
 * is off. WebSocket/HTTP wiring implements this interface elsewhere.
 */
export interface RelayTransport {
  putBucket(req: {
    appScope: string;
    epoch: number;
    shard: string;
    entries: PresenceEntry[];
  }): Promise<void>;
  getBucket(req: { appScope: string; epoch: number; shard: string }): Promise<PresenceEntry[]>;
}

/** injectable CSPRNG (default: WebCrypto). Overridable for deterministic tests. */
export type RandomBytes = (n: number) => Uint8Array;

const webcryptoRandomBytes: RandomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface ContactRelayOptions {
  /**
   * App scope string - the bucket namespace shared by both friends. Same value
   * passed to `rendezvousTag` as `appOrigin`, so expected/published tags agree.
   */
  appOrigin: string;
  /** F: constant entries per PUT (per shard). MUST be >= your max friend count. */
  padTo: number;
  /**
   * Fixed presence-blob size in bytes (the AEAD ciphertext length from
   * `presence-blob.ts`). Dummies match it and every real blob is asserted equal
   * to it - a wrong-size real blob is an indistinguishability break, so it fails
   * loudly rather than leaking real-vs-dummy by length.
   */
  blobBytes: number;
  /**
   * Invariant 3. 0 = single bucket (default, recommended). N > 0 su shards by
   * the tag's leading N bytes and leaks which-prefix - opt in only past scale.
   */
  shardPrefixBytes?: number;
  /** CSPRNG override (tests inject a deterministic one). */
  randomBytes?: RandomBytes;
}

/** a friend's presence found in the bucket this epoch. */
export interface PresentFriend {
  /** caller's handle for the friend (echoed from the query). */
  id: string;
  /** the matched rendezvous tag. */
  tag: Uint8Array;
  /** the friend's opaque encrypted presence blob (decrypt via presence-blob.ts). */
  blob: Uint8Array;
}

/**
 * A friend to look for. `friendPubHex` is the friend's `ContactCardKey.publicKey`
 * (the publisher pub THEY announce under); `rootSecret` is the cached pairwise
 * secret (`zidContactRootSecret`). We keep zid decoupled from the extension's
 * `ContactCardKey` type by taking just the public-key hex it carries.
 */
export interface FriendPresenceQuery {
  id: string;
  friendPubHex: string;
  rootSecret: Uint8Array;
}

/** local summary of a publish - for the caller/tests, never sent to the relay. */
export interface PublishOutcome {
  epoch: number;
  /** entries written per shard (always === padTo). */
  perShard: number;
  /** shards written to (['' ] when sharding is off). */
  shards: string[];
  /** real (non-dummy) entries across all shards. */
  realCount: number;
}

// ---------------------------------------------------------------------------
// Local matcher (invariant 1's local half) - exported standalone + reused
// ---------------------------------------------------------------------------

/**
 * Compute the tags I expect each friend to publish under this epoch. To FIND
 * friend j I derive the tag with j's OWN pubkey (that is the direction the tag
 * encodes - see `rendezvousTag`), from our shared root secret.
 */
export const expectedFriendTags = (
  friends: readonly FriendPresenceQuery[],
  appOrigin: string,
  epoch: number,
): Map<string, Uint8Array> => {
  const out = new Map<string, Uint8Array>();
  for (const f of friends) {
    out.set(f.id, rendezvousTag(f.rootSecret, appOrigin, epoch, f.friendPubHex));
  }
  return out;
};

/**
 * Intersect a fetched bucket with my expected friend tags, LOCALLY. Builds a
 * hex-keyed index of the bucket once, then looks up each expected tag - so the
 * work (and, in the network layer, the access pattern) does not depend on which
 * or how many friends matched.
 */
export const matchBucket = (
  bucket: readonly PresenceEntry[],
  expected: ReadonlyMap<string, Uint8Array>,
): PresentFriend[] => {
  const index = new Map<string, Uint8Array>();
  for (const e of bucket) {
    index.set(bytesToHex(e.tag), e.blob);
  }
  const present: PresentFriend[] = [];
  for (const [id, tag] of expected) {
    const blob = index.get(bytesToHex(tag));
    if (blob !== undefined) {
      present.push({ id, tag, blob });
    }
  }
  return present;
};

// ---------------------------------------------------------------------------
// ContactRelay client
// ---------------------------------------------------------------------------

export class ContactRelay {
  private readonly transport: RelayTransport;
  private readonly appOrigin: string;
  private readonly padTo: number;
  private readonly blobBytes: number;
  private readonly shardPrefixBytes: number;
  private readonly rnd: RandomBytes;

  constructor(transport: RelayTransport, options: ContactRelayOptions) {
    if (options.padTo < 1) {
      throw new Error('ContactRelay: padTo (F) must be >= 1');
    }
    if (options.blobBytes < 1) {
      throw new Error('ContactRelay: blobBytes must be >= 1');
    }
    const shardBytes = options.shardPrefixBytes ?? 0;
    if (shardBytes < 0 || shardBytes >= RENDEZVOUS_TAG_BYTES) {
      throw new Error(
        `ContactRelay: shardPrefixBytes must be in [0, ${RENDEZVOUS_TAG_BYTES}); 0 disables sharding`,
      );
    }
    this.transport = transport;
    this.appOrigin = options.appOrigin;
    this.padTo = options.padTo;
    this.blobBytes = options.blobBytes;
    this.shardPrefixBytes = shardBytes;
    this.rnd = options.randomBytes ?? webcryptoRandomBytes;
  }

  /** the shard a tag belongs to: '' when sharding is off, else its hex prefix. */
  shardOf(tag: Uint8Array): string {
    if (this.shardPrefixBytes === 0) {
      return '';
    }
    return bytesToHex(tag.subarray(0, this.shardPrefixBytes));
  }

  /**
   * INVARIANT 2. Publish `entries` (already-computed real (tag, blob) records,
   * blobs sealed by presence-blob.ts) as constant-size, dummy-padded, shuffled
   * PUT batches. Deliberately batch-only: a single-entry publish could not
   * enforce a constant F, so the friend count would leak through call patterns.
   * With sharding off, always writes exactly one bucket of F entries - even for
   * zero real friends (fixed cadence).
   */
  async publishPresence(
    entries: readonly PresenceEntry[],
    epoch: number = presenceEpoch(),
  ): Promise<PublishOutcome> {
    for (const e of entries) {
      if (e.tag.length !== RENDEZVOUS_TAG_BYTES) {
        throw new Error(
          `ContactRelay: tag must be ${RENDEZVOUS_TAG_BYTES} bytes, got ${e.tag.length}`,
        );
      }
      if (e.blob.length !== this.blobBytes) {
        throw new Error(
          `ContactRelay: presence blob must be exactly blobBytes=${this.blobBytes} (indistinguishability), got ${e.blob.length}`,
        );
      }
    }

    // group reals by shard. sharding off => the single '' shard, always present.
    const byShard = new Map<string, PresenceEntry[]>();
    if (this.shardPrefixBytes === 0) {
      byShard.set('', []);
    }
    for (const e of entries) {
      const shard = this.shardOf(e.tag);
      const bucket = byShard.get(shard);
      if (bucket === undefined) {
        byShard.set(shard, [e]);
      } else {
        bucket.push(e);
      }
    }

    const shards: string[] = [];
    let realCount = 0;
    for (const [shard, reals] of byShard) {
      if (reals.length > this.padTo) {
        throw new Error(
          `ContactRelay: ${reals.length} real tags in shard '${shard}' exceeds padTo=${this.padTo}; raise padTo`,
        );
      }
      realCount += reals.length;
      const padded = this.padAndShuffle(reals, shard);
      await this.transport.putBucket({
        appScope: this.appOrigin,
        epoch,
        shard,
        entries: padded,
      });
      shards.push(shard);
    }

    return { epoch, perShard: this.padTo, shards, realCount };
  }

  /**
   * INVARIANT 1. Find which friends are present this epoch: derive expected tags
   * locally, fetch the FULL bucket(s) they fall in, and intersect in-memory. No
   * per-friend GET. With sharding off this is one whole-bucket fetch regardless
   * of friend count - a zero-friend call still fetches, keeping the read shape
   * uniform.
   */
  async discover(
    friends: readonly FriendPresenceQuery[],
    epoch: number = presenceEpoch(),
  ): Promise<PresentFriend[]> {
    const expected = expectedFriendTags(friends, this.appOrigin, epoch);

    // which shards must we fetch? off => just ''. on => the distinct prefixes of
    // the expected tags (this is the documented which-prefix leak).
    const shards = new Set<string>();
    if (this.shardPrefixBytes === 0) {
      shards.add('');
    } else {
      for (const tag of expected.values()) {
        shards.add(this.shardOf(tag));
      }
    }

    const bucket: PresenceEntry[] = [];
    for (const shard of shards) {
      const part = await this.transport.getBucket({
        appScope: this.appOrigin,
        epoch,
        shard,
      });
      for (const e of part) {
        bucket.push(e);
      }
    }

    return matchBucket(bucket, expected);
  }

  /** pad reals up to F with shard-consistent dummies, then shuffle in place. */
  private padAndShuffle(reals: readonly PresenceEntry[], shard: string): PresenceEntry[] {
    const batch: PresenceEntry[] = [...reals];
    while (batch.length < this.padTo) {
      batch.push(this.makeDummy(shard));
    }
    this.shuffle(batch);
    return batch;
  }

  /**
   * A dummy indistinguishable in shape from a real entry: a uniformly random
   * tag and a uniformly random blob of `blobBytes`. When sharding is on the tag
   * carries the shard's prefix so the dummy actually lands in - and matches the
   * shape of reals within - that shard.
   */
  private makeDummy(shard: string): PresenceEntry {
    const tag = this.rnd(RENDEZVOUS_TAG_BYTES);
    if (shard.length > 0) {
      const prefix = hexToBytes(shard);
      tag.set(prefix.subarray(0, RENDEZVOUS_TAG_BYTES), 0);
    }
    return { tag, blob: this.rnd(this.blobBytes) };
  }

  /** Fisher-Yates shuffle drawing indices from the injected CSPRNG. */
  private shuffle(arr: PresenceEntry[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randomIndex(i + 1);
      const a = arr[i];
      const b = arr[j];
      if (a !== undefined && b !== undefined) {
        arr[i] = b;
        arr[j] = a;
      }
    }
  }

  /** uniform integer in [0, bound) via rejection sampling over random bytes. */
  private randomIndex(bound: number): number {
    if (bound <= 1) {
      return 0;
    }
    // 4 random bytes -> uint32; reject the biased tail for a uniform result.
    const limit = Math.floor(0x100000000 / bound) * bound;
    for (;;) {
      const b = this.rnd(4);
      const v = (b[0] ?? 0) * 0x1000000 + (b[1] ?? 0) * 0x10000 + (b[2] ?? 0) * 0x100 + (b[3] ?? 0);
      if (v < limit) {
        return v % bound;
      }
    }
  }
}
