/**
 * Decoy padding for the trustless-sync proof queries.
 *
 * ── the leak this addresses ────────────────────────────────────────────────
 *
 * Sync verification asks the server two questions about the wallet's own
 * notes:
 *
 *   GetCommitmentProofs(cmx[], position[])  — "prove these outputs are in the
 *                                              commitment tree"
 *   GetNullifierProofs(nullifier[])         — "are these notes spent yet?"
 *
 * Sent unpadded, both are a complete inventory of the wallet. A (cmx,
 * position) pair indexes straight into the block that contains it, so the
 * server learns exactly which on-chain outputs belong to this user. An
 * *unspent* nullifier is worse: it is not yet on-chain, so the server can
 * store it and match it the moment it appears in a block — deanonymising a
 * future spend prospectively, before the user has made it. Against the
 * server operator the anonymity set of an unpadded query is 1.
 *
 * ── what this module does ─────────────────────────────────────────────────
 *
 * It mixes each real item in with `ratio` decoys, so the server sees
 * (1 + ratio)·N items and cannot tell, *from the request alone*, which are
 * the user's.
 *
 * Two properties matter more than the ratio itself:
 *
 * 1. DECOYS ARE DETERMINISTIC AND STABLE, derived by a PRF from a
 *    per-wallet secret seed. This is the whole ballgame. Freshly random
 *    decoys on every sync would be *worse than useless*: the real items
 *    recur in every query and the decoys never do, so the server intersects
 *    a handful of sessions and the real set falls straight out. Because the
 *    decoys are a pure function of the item and the seed, repeating a sync
 *    re-sends a byte-identical query and the server learns nothing from the
 *    repetition.
 *
 * 2. DECOY NULLIFIERS ARE UNIFORM OVER THE PALLAS BASE FIELD, which is where
 *    real orchard nullifiers live. Sampling uniform 32-byte strings would
 *    have been trivially separable — roughly a quarter of them exceed the
 *    field modulus and could not be a nullifier at all.
 *
 * Commitment decoys are drawn from a reservoir of (cmx, position) pairs the
 * scanner actually observed in the blocks it just walked. They have to be
 * real tree entries: a cmx that is not in the tree gets no proof back, which
 * identifies it as a decoy immediately. Drawing from the just-scanned range
 * also gives the recency-weighted distribution the real notes have — decoys
 * sampled uniformly over all of chain history would cluster in the wrong
 * place and be separable on that alone.
 *
 * ── what this does NOT do (read this before trusting it) ──────────────────
 *
 * This is padding, not private information retrieval. Honestly stated:
 *
 *   - The nullifier anonymity set is (1 + ratio), i.e. 3 at the default
 *     ratio of 2. It is not the chain's anonymity set. A server that wants
 *     to watch this user still has a 1-in-3 guess per note, and it is a
 *     cheap guess to make.
 *
 *   - The protection is RETROSPECTIVE-ONLY for spends. When the user spends,
 *     the real nullifier appears on-chain; the decoys never will. The server
 *     can then look back and mark which member of each triple was real. What
 *     the padding actually buys is the destruction of the *prospective*
 *     attack — the server can no longer build a watchlist that fires the
 *     instant the user spends — and it costs the operator work to unwind
 *     rather than handing it over.
 *
 *   - The batch is still linkable to a single wallet. Queries are grouped
 *     per sync, arrive on one connection, and the item set grows
 *     monotonically. The server does not learn *which* notes are yours as
 *     directly, but it certainly still learns that one wallet holds this
 *     group of ~3N candidates. Padding does not give unlinkability.
 *
 *   - The seed lives in the wallet's IndexedDB `meta` store. Clearing the
 *     cache regenerates it, which re-rolls every decoy while the real items
 *     stay the same — exactly the intersection the stability property exists
 *     to prevent. A clear-and-resync therefore leaks materially more than a
 *     steady-state sync. See `getDecoySeed` in zcash-worker.ts.
 *
 *   - Commitment decoy stability is best-effort. It is deterministic given
 *     the same reservoir, but the reservoir depends on how the scan batched
 *     blocks, so a resync with different batching draws different decoys.
 *
 * The real fix for all of the above is to stop asking the server
 * item-by-item questions at all (batch-and-filter, or a PIR-shaped
 * protocol). This module is mitigation, not that fix.
 */

import { sha512 } from '@noble/hashes/sha512';

/**
 * Pallas base field modulus. Orchard nullifiers are `Extract_P` outputs —
 * the x-coordinate of a Pallas point — so they are elements of F_p
 * serialised little-endian.
 */
const PALLAS_BASE_MODULUS = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n;

/** decoys per real item. */
export const DEFAULT_DECOY_RATIO = 2;

/** cap on the observed-commitment reservoir, to bound worker memory. */
export const DECOY_POOL_CAP = 1024;

export interface CommitmentItem {
  readonly cmx: Uint8Array;
  readonly position: number;
}

const te = new TextEncoder();

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};

/** PRF(seed, domain, item, counter) -> 64 bytes. */
const prf = (seed: Uint8Array, domain: string, item: Uint8Array, counter: number): Uint8Array =>
  sha512(concatBytes(te.encode(domain), seed, item, u32le(counter)));

/** interpret bytes little-endian as a BigInt. */
const leToBigInt = (b: Uint8Array): bigint => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(b[i]!);
  }
  return v;
};

/** serialise a field element little-endian into 32 bytes. */
const bigIntToLe32 = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

/**
 * Derive `ratio` decoy nullifiers for a real nullifier.
 *
 * Wide (512-bit) reduction into F_p. The modular bias against a true uniform
 * sample is on the order of 2^-260 and is not a distinguisher.
 */
export const decoyNullifiersFor = (
  seed: Uint8Array,
  realNullifier: Uint8Array,
  ratio: number,
): Uint8Array[] => {
  const out: Uint8Array[] = [];
  for (let j = 0; j < ratio; j++) {
    const wide = leToBigInt(prf(seed, 'zafu:decoy:nullifier:v1', realNullifier, j));
    out.push(bigIntToLe32(wide % PALLAS_BASE_MODULUS));
  }
  return out;
};

/**
 * Deterministic keyed shuffle.
 *
 * Position leaks: appending decoys after the real items would let the server
 * read the real set straight off the request ordering. The permutation is
 * derived from the seed rather than from `crypto.getRandomValues` so that a
 * repeated query is byte-identical (see the stability note in the header) —
 * a per-session random order would make otherwise-identical queries
 * distinguishable from each other, which is a small leak but a free one to
 * avoid.
 */
export const seededShuffle = <T>(items: T[], seed: Uint8Array, domain: string): T[] => {
  const out = items.slice();
  // Fisher-Yates driven by a PRF stream keyed on the seed and set size, so
  // the permutation is stable for a stable set.
  for (let i = out.length - 1; i > 0; i--) {
    const stream = prf(seed, domain, u32le(out.length), i);
    const r = Number(leToBigInt(stream.subarray(0, 6)) % BigInt(i + 1));
    const tmp = out[i]!;
    out[i] = out[r]!;
    out[r] = tmp;
  }
  return out;
};

export interface PaddedNullifierQuery {
  /** real + decoy nullifiers, shuffled. this is what goes on the wire. */
  readonly query: Uint8Array[];
  /** hex of the REAL nullifiers only — proofs outside this set are ignored. */
  readonly realHex: ReadonlySet<string>;
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/**
 * Pad a nullifier query with stable decoys and shuffle it.
 *
 * The caller MUST evaluate proofs against `realHex` only. Decoy proofs carry
 * no meaning: the server is free to return anything for them, and acting on
 * a decoy answer would let it forge spend state for a note that is not ours.
 */
export const padNullifierQuery = (
  realNullifiers: Uint8Array[],
  seed: Uint8Array | null,
  ratio = DEFAULT_DECOY_RATIO,
): PaddedNullifierQuery => {
  const realHex = new Set(realNullifiers.map(toHex));
  if (!seed || ratio <= 0 || realNullifiers.length === 0) {
    return { query: realNullifiers.slice(), realHex };
  }
  const all: Uint8Array[] = realNullifiers.slice();
  const seen = new Set(realHex);
  for (const nf of realNullifiers) {
    for (const d of decoyNullifiersFor(seed, nf, ratio)) {
      const h = toHex(d);
      // a decoy colliding with a real nullifier would be indistinguishable
      // from us asking about it twice; drop it rather than duplicate.
      if (seen.has(h)) {
        continue;
      }
      seen.add(h);
      all.push(d);
    }
  }
  return { query: seededShuffle(all, seed, 'zafu:decoy:nf-order:v1'), realHex };
};

export interface PaddedCommitmentQuery {
  readonly cmxs: Uint8Array[];
  readonly positions: number[];
  /** hex of the REAL cmxs only. */
  readonly realHex: ReadonlySet<string>;
}

/**
 * Pad a commitment query with decoys drawn from observed tree entries.
 *
 * `pool` must contain (cmx, position) pairs the scanner actually saw on
 * chain — a fabricated cmx has no proof and outs itself. If the pool is too
 * small to supply the requested decoys we add what we can; that is graceful
 * degradation of the anonymity set, not an error, and the caller logs the
 * achieved ratio rather than the requested one.
 */
export const padCommitmentQuery = (
  real: CommitmentItem[],
  pool: readonly CommitmentItem[],
  seed: Uint8Array | null,
  ratio = DEFAULT_DECOY_RATIO,
): PaddedCommitmentQuery => {
  const realHex = new Set(real.map(r => toHex(r.cmx)));
  if (!seed || ratio <= 0 || real.length === 0 || pool.length === 0) {
    return {
      cmxs: real.map(r => r.cmx),
      positions: real.map(r => r.position),
      realHex,
    };
  }

  const candidates = pool.filter(p => !realHex.has(toHex(p.cmx)));
  const items: CommitmentItem[] = real.slice();
  const used = new Set<string>();

  for (const r of real) {
    for (let j = 0; j < ratio && candidates.length > 0; j++) {
      // index the observed pool by a PRF on the real item, so the same note
      // re-draws the same decoys given the same pool.
      const stream = prf(seed, 'zafu:decoy:cmx:v1', r.cmx, j);
      const start = Number(leToBigInt(stream.subarray(0, 6)) % BigInt(candidates.length));
      // linear probe forward for an unused candidate
      let picked: CommitmentItem | null = null;
      for (let k = 0; k < candidates.length; k++) {
        const c = candidates[(start + k) % candidates.length]!;
        const h = toHex(c.cmx);
        if (!used.has(h)) {
          used.add(h);
          picked = c;
          break;
        }
      }
      if (!picked) {
        break;
      }
      items.push(picked);
    }
  }

  const shuffled = seededShuffle(items, seed, 'zafu:decoy:cmx-order:v1');
  return {
    cmxs: shuffled.map(i => i.cmx),
    positions: shuffled.map(i => i.position),
    realHex,
  };
};

/**
 * Reservoir-sample observed commitments so the decoy pool stays bounded and
 * is not biased toward the start of a scan batch.
 */
export class CommitmentReservoir {
  private items: CommitmentItem[] = [];
  private seen = 0;

  constructor(private readonly cap: number = DECOY_POOL_CAP) {}

  offer(cmx: Uint8Array, position: number): void {
    this.seen++;
    if (this.items.length < this.cap) {
      this.items.push({ cmx, position });
      return;
    }
    // classic reservoir replacement; crypto RNG is unnecessary here because
    // the pool only has to be unbiased, not unpredictable — the *selection*
    // from it is what is keyed.
    const r = Math.floor(Math.random() * this.seen);
    if (r < this.cap) {
      this.items[r] = { cmx, position };
    }
  }

  snapshot(): readonly CommitmentItem[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.seen = 0;
  }
}
