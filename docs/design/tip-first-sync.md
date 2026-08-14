# Tip-first (spend-before-sync) scan scheduling

Status: design / not yet implemented
Scope: `apps/extension/src/workers/zcash-worker.ts`, `apps/extension/src/state/keyring/zcash-backend.ts`

## Provenance (clean-room)

The technique here is the standard Zcash light-client **priority scan queue**:
`zcash_client_backend::data_api::scanning::ScanPriority` (`ChainTip`, `Verify`,
`FoundNote`, `OpenAdjacent`, `Historic`) and `suggest_scan_ranges`, which zafu
already links transitively through librustzcash. This document specifies zafu's
own implementation of that upstream technique for zafu's architecture (a
TS/WASM extension over a multi-backend, partly-trustless transport). It cites
only the permissive upstream primitive; no third-party engine code is used or
copied.

## Problem

zafu scans **linearly forward** from the wallet birthday / import height and
anchors witnesses at the cached sync frontier (`getTreeFrontierHeight`,
`zcash-worker.ts:1491`). Consequence: a restored or freshly-imported wallet must
grind through history before any spendable note appears - the user stares at a
progress bar with a zero balance even though their most recent, most-likely-to-
be-spent funds are near the tip.

Goal: **surface spendable notes in seconds** by scanning the most-recent range
first, then backfilling history in the background - without weakening zidecar's
trust guarantees and without diverging the lwd/zaino code path.

## Non-goals

- Not a rewrite of the note-decryption, nullifier, or tree-hash kernels (those
  stay in `@repo/zcash-wasm`, unchanged).
- Not a change to the persisted note/witness store shape.
- Not a new consensus or verification rule.

## Core idea

Replace "one linear cursor from birthday to tip" with "a **priority queue of
scan ranges**, highest priority first". The most-recent range (`ChainTip`) is
processed before deep `Historic` ranges, so witnesses for recent notes are built
first and a **spendable signal** can fire the moment no `ChainTip`/`Verify`
range remains pending - long before the full history is scanned.

Priority order (highest first), mirroring the upstream contract:

1. `Verify` - a short range near a previously-scanned boundary that must be
   re-checked (reorg tail).
2. `ChainTip` - the most-recent ~N blocks. Scanned first; completing it latches
   "recent funds spendable".
3. `FoundNote` / `OpenAdjacent` - ranges needed to complete a shard/witness for
   a note we just found.
4. `Historic` - everything else, oldest-relevant to newest, in the background.

## Backend-agnostic architecture (lwd / zaino / zidecar)

The scheduler must be **identical** across all backends; only the _transport_
and the _trust_ differ. Model that with two small interfaces plus a trust
**filter**, extending the existing `ZcashClient` abstraction in
`zcash-backend.ts` rather than branching per backend in the worker.

```ts
// Where compact blocks come from. lwd/zaino stream GetBlockRange; zidecar
// serves the same shape (its own RPC). Backend-agnostic.
interface BlockSource {
  // Concurrent, resumable, byte-budgeted range fetch (see "Fetch" below).
  fetchRange(from: number, to: number, opts: FetchOpts): AsyncIterable<CompactBlockChunk>;
  getTip(): Promise<ChainTip>;
}

// Seeds the commitment tree so a range can be scanned WITHOUT having scanned
// everything below it. lwd/zaino: GetTreeState / GetSubtreeRoots (trusted).
// zidecar: the same, optionally proof-carrying (see "Trust").
interface TreeStateProvider {
  treeStateAt(height: number): Promise<TreeState>; // orchard + ironwood frontiers
  // Optional: a checkpoint the client can VERIFY rather than trust.
  verifiableCheckpoint?(height: number): Promise<VerifiableCheckpoint>;
}
```

**Trust is a filter, not a branch.** The scheduler consumes a
`TreeStateProvider` and never asks which backend it is. For zidecar we wrap the
provider:

```ts
// zidecar only: verify the proof (ligerito/NOMT) before the tree-state is
// allowed to seed a witness anchor. lwd/zaino use the bare provider.
const provider =
  backend === 'zidecar'
    ? verifyingTreeStateProvider(zidecarProvider) // proof-checking wrapper
    : trustedTreeStateProvider(lwdClient); // pass-through
```

This keeps one scheduler and one fetch/scan/persist pipeline for all three
backends; the only backend-specific code is the thin transport client and the
zidecar verification wrapper (which already exists in spirit - the actions-
commitment fold and header/epoch proofs).

## The trustless nuance for zidecar (the one real constraint)

Jumping to the tip means seeding the commitment tree at a non-genesis height.
zafu already does this (frontier-anchored witnesses) and already accepts that
the trustless **actions-commitment fold is only meaningful when genesis-
anchored** - the default near-tip start is not (`zcash-worker.ts:1154-1158`).
So tip-first does not weaken anything that a near-tip start has not already
relaxed. Two postures, selectable per wallet:

- **Trusted seed (default, matches today):** `treeStateAt(tip - N)` from the
  backend seeds the anchor. For lwd/zaino this is the normal trust model; for
  zidecar it is the same relaxation zafu already ships for near-tip starts.
- **Verifiable seed (zidecar):** the client seeds from a checkpoint whose state
  root it VERIFIES rather than trusts - preserving full trustlessness across a
  tip-first jump. Investigation resolved this in favour of "feasible with a small
  zidecar change": the machinery already exists (see below).

### How the zidecar trustless state actually composes

zidecar's trust is a **composition of three legs**, not a single tree - and
knowing which leg does what is what makes the checkpoint change small:

1. **NOMT (current state):** the nullifier/commitment set is a NOMT sparse
   merkle tree; `nullifier_root` in `TrustlessStateProof` is `nomt.root()`.
   `get_nullifier_proof` / `get_commitment_proof` are NOMT membership proofs
   against the **current** root - used at SPEND time. **NOMT is single-versioned**
   (one live tree): it cannot prove against a past height, only the tip.
2. **Ligerito (state over time):** the header-chain proof binds per-height state
   roots to a PoW-weighted (`cumulative_difficulty`) header chain via its
   `final_state_commitment`. This is what makes a _past-height_ root trustless -
   not a NOMT proof (NOMT can't reach back).
3. **FROST checkpoint (trust anchor) - PROTO-RESERVED, NOT IMPLEMENTED.** The
   `FrostCheckpoint { epoch_index, height, ... }` field exists in the proto and
   is intended to be the FROST-signed anchor the ligerito proof runs FROM, but it
   is **never constructed anywhere in zidecar** (`checkpoint: None`). `frost_relay/`
   is the multisig-signing blob relay, unrelated to checkpoints. So there is
   currently **no cryptographic trust anchor below the ligerito start**.

**What the anchor actually bottoms out at today:** the ligerito proof runs from a
**configured `start_height`** (trusted by configuration), not a FROST checkpoint
and not yet genesis. Genesis-anchoring the header/epoch proofs is in-progress work
(the "low/genesis start" task). Until either that lands (anchor becomes genesis +
PoW weight, no trusted config) OR FROST checkpoints are implemented, the seed is
trustless only as far as that configured start - the same "partial, not fully
trustless" limitation the header-proof work already tracks.

Because NOMT is single-versioned, historical/checkpoint roots do NOT come from
NOMT - they come from a **per-height root log in sled** (`store_state_roots` /
`get_state_roots(height)`, keyed `b'r'+height`), made trustless (up to the anchor)
by leg 2. So a tip-first witness seed at a stable past height needs **no NOMT
multi-versioning** (a large, invasive change we avoid); it rides the existing sled
root-log + ligerito binding, while NOMT keeps serving current-state spend proofs
unchanged.

### The zidecar change needed (small; no new primitives)

`TrustlessStateProof` already carries the right fields (`checkpoint:
FrostCheckpoint`, `state_transition_proof`, `tree_root`, `nullifier_root`) and
`ProofRequest` already carries `to_height` - but `handle_get_trustless_state_proof`
currently ignores the requested height, always anchors at the raw tip, and leaves
`checkpoint: None`. The change:

1. Anchor at a **stable height** - default to the **last completed epoch
   boundary** (reorg-safe, and its ligerito proof + roots already exist), or
   honour `ProofRequest.to_height`.
2. `get_state_roots(anchor_height)` instead of `get_state_roots(tip)` (storage is
   already height-keyed - a lookup, not a recompute).
3. Return the epoch's already-generated ligerito proof (start -> anchor); no
   on-demand proving on the hot path.

That much is a **small handler change** (no proto/storage/crypto change, NOMT
untouched, lwd/zaino unaffected) - and it gives a seed that is trustless **up to
the configured ligerito start**. Making the seed _fully_ trustless is the separate,
larger piece: EITHER finish genesis-anchoring the ligerito proof (then no trusted
start), OR implement FROST checkpoints and populate `checkpoint` (today it is a
proto-reserved blank, never constructed - so filling it is building the anchor
feature, not a one-line handler edit). Do NOT conflate the two: the handler change
enables tip-first ordering; the anchor work is what makes it trustless.

Client side (zafu): verify the FROST checkpoint signature -> verify the ligerito
state-transition proof (checkpoint -> anchor, incl. PoW weight) -> trust
`tree_root`/`nullifier_root` at the anchor -> fetch `get_tree_state(anchor)` and
check `frontier.root() == tree_root` -> seed the witness anchor -> tip-first scan
the recent range. Spend-time nullifier/commitment checks continue against the
live NOMT root as today.

Genesis-anchored (fully-trustless-from-birth) wallets keep the linear path -
they must fold contiguously from genesis for the fold to verify, so they opt out
of tip-first by construction. The scheduler picks the path from the wallet's
existing genesis-anchored flag.

## Supporting ideas (backend-agnostic, adopt alongside)

These are independent of the priority ordering and help every backend:

- **Byte-budgeted sub-chunk splitting.** Split a fetched range into sub-chunks
  bounded by _bytes_, not block count, so the dense 2022-23 "sandblasting" era
  (hundreds of MB per 10k blocks) stays memory-bounded and timeout-immune;
  retries resume from the last emitted height. zafu already caps concurrent
  fetches (`zcash-worker.ts:2095`); this adds density-adaptivity.
- **Write-behind persistence overlap.** Commit chunk N's decrypted notes/witness
  updates while chunk N+1 is decrypting, strictly in order. Hides store-write
  latency under scan.
- **Mid-pass endpoint failover.** On a stalled/collapsed stream, fail over to an
  alternate endpoint of the _same backend kind_ and resume from the last height,
  bounded to a couple of attempts. Composes with the existing graceful network
  error handling.

## Incremental rollout

1. **Interface seam.** Introduce `BlockSource` / `TreeStateProvider` over the
   existing `ZcashClient`; no behavior change (linear scheduler still). Pure
   refactor, tsc-gated.
2. **Priority queue + ChainTip-first.** Implement the range priority queue and
   process `ChainTip` before `Historic`. Add the spendable latch -> surface a
   "recent funds ready" balance/UI signal. Trusted seed only; behavior identical
   for genesis-anchored wallets.
3. **Fetch/persist ideas.** Byte-budgeted splitting + write-behind overlap.
4. **Verifiable zidecar checkpoint (optional).** Only if/when zidecar can serve
   a proof-carrying checkpoint; makes tip-first fully trustless on zidecar.

Each step is independently shippable and independently testable against the
existing oracle (a linear-scanned wallet DB must remain reachable and identical
in final state; only the _order_ work is done changes, not the result).

## Ecosystem alignment

The scheduler and the backend seam ride ecosystem standards, not bespoke
inventions - this is the "stop going cowboy" discipline applied to sync:

- Scan priority is **`zcash_client_backend::ScanPriority`** / `suggest_scan_ranges`
  (librustzcash) - the upstream technique zafu already links, not a home-grown
  ordering.
- The multi-backend `BlockSource` should converge on the **`CompactTxStreamer`
  gRPC contract** that lightwalletd and **zaino** (the ecosystem's lightwalletd
  successor) implement, so lwd / zaino / zidecar are ONE interface with trust as a
  filter (zidecar = the same contract, plus proofs). Do not grow a fourth bespoke
  surface.

The novel piece - trustless tip-first seeding via a verified checkpoint - is the
extension worth standardizing; its trust root is the FlyClient/ZIP-221 header
proof (see `zcli` `docs/design/flyclient-header-proof.md`), which is itself a
ride-the-standard change with a ZIP path noted there.

## Correctness invariant

The final synced state (notes, nullifiers, witnesses, balances) MUST be
identical whether ranges are scanned tip-first or linearly - only scheduling
changes, never the per-block math. Any tip-first pass must converge to the same
frontier and note set a linear pass would. This is the property to oracle-test
before enabling tip-first by default.
