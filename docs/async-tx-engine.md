# Async transaction engine — seamless, non-blocking tx creation

Status: design. Parent tracking item: [#31](https://github.com/rotkonetworks/zafu/issues/31)
("multiple transactions in the same block").

## Goal

A user on dex.rotko.net (or in the extension) should be able to fire transaction
after transaction — sends, swaps, TWAP slices, agent actions — and **never hit a
"wait for the next block" wall**. Every click returns "accepted" in
milliseconds; the engine settles the work across blocks as fast as the protocol
legally allows, and shows settlement only as passive progress.

## The one insight: convert _chains_ into _lanes_

The block boundary is not what stalls the user — **chaining** is.

- A **chain** is tx B that spends a note tx A just created. B genuinely cannot
  exist until A commits and the client scans it (see Fact 3). Chains are strictly
  one-per-block and cannot be pre-proven.
- A **lane** is a tx that spends a **disjoint, already-committed** note. Lanes are
  independent: they can be built, proven, and submitted _right now_, in parallel,
  and settle together in the same block.

Everything in this design exists to keep user intents on **lanes** and only fall
back to chaining when unavoidable.

## Protocol grounding (verified against `/steam/rotko/penumbra`)

Three facts were confirmed by reading the Penumbra source. They make the pipeline
freer than a typical shielded chain.

### Fact 1 — There is NO anchor-staleness window. Pre-proving is unbounded.

Every historical State Commitment Tree (SCT) root is stored permanently and stays
valid for spending forever — there is no "last N roots" window.

- Write (every block): `crates/core/component/sct/src/component/tree.rs:82`
  `put_proto(anchor_lookup(sct_anchor), height)` — never pruned/deleted.
- Check: `sct/src/component/tree.rs:225-242` `check_claimed_anchor` — valid iff the
  root was _ever_ a block root.
- Caller: `crates/core/app/src/action_handler/transaction/stateful.rs:136-141`.

**Implication:** a spend proof built against any committed anchor **never goes
stale**. You may pre-prove arbitrarily far ahead. (Contrast Zcash/Orchard, which
keep a bounded root window — that constraint does not exist here.) One caveat: the
anchor is a single tree root per transaction; all spends in one tx share it, so
every note witnessed in that tx must exist as of the chosen root's block.

### Fact 2 — `expiry_height` is the only deadline.

- Domain type: `crates/core/transaction/src/parameters.rs:10`; proto
  `penumbra.core.transaction.v1` `expiry_height: u64`.
- Check: `stateful.rs:48-65` `expiry_height_is_valid` — `0` means "never expires";
  a future height is accepted and rejected only once the chain passes it. It's a
  _historical_ check (safe against past state).

**Implication:** the pipeline's single deadline knob is `expiry_height`. Set it
generously (or `0`) on pre-proven txs; the anchor imposes no deadline.

### Fact 3 — A spend can be proven only after its source note's block commits + is scanned.

The spend proof takes the note's **Position** and **Merkle authentication path**
as private inputs, obtained from the SCT `witness()` API.

- Private inputs: `crates/core/component/shielded-pool/src/spend/proof.rs:53-57`
  (`state_commitment_proof: tct::Proof`), witnessed at `proof.rs:153-158`
  (`PositionVar`, `MerkleAuthPathVar`); nullifier binds the position at
  `proof.rs:185`.
- Witness only exists post-insertion: `crates/view/src/service.rs:1582` errors
  `"Note commitment missing"` if not yet scanned; insertion happens in
  `add_sct_commitment` (`sct/src/component/tree.rs:119-133`) during block execution.

**Implication:** you cannot pre-prove a spend of a note created in the same (or a
not-yet-committed) block. Earliest prove time for a note = after its creating
block is final and the view client has scanned it. This is exactly why chains
can't be pipelined and lanes can.

### The only invalidator

`check_nullifier_unspent` (`sct/src/component/tree.rs:244-258`) rejects a tx whose
note was spent in the interim. Since we are the sole spender of our notes, the
**only** way a pre-proven tx becomes invalid is if _we_ reused its note in another
queued tx. That makes the reservation manager the single load-bearing correctness
component.

## Architecture

All of this lives in the **extension** (custody + state authority). Apps only fire
intents and render status.

### 1. Optimistic note ledger

Two layers over the note set:

- **Confirmed** — notes whose commitments are in a committed anchor; nullifiers
  known-unspent.
- **Projected** — confirmed, minus notes reserved by in-flight txs, plus the
  outputs those txs will mint (my change, my swap-claim outputs), each tagged with
  an **`earliest-spendable-height`** = the height at which its witness exists.

Planning selects from the projected layer filtered to
`earliest-spendable-height <= target_height`. That single tag encodes the entire
same-block constraint.

### 2. Reservation manager (the correctness core)

Atomic reserve/release of notes, keyed by pending op. A note is reserved _before_
any proving starts and released on confirm-or-abandon. Invariant: **no two
in-flight txs ever hold the same note** (would collide on nullifier per Fact-3's
binding and be rejected). This is the single source of nullifier truth.

### 3. Dependency DAG scheduler

Pending txs form a graph; edge A→B means "B spends an output of A."

- No edge → A, B share a block (**lane**).
- Edge → B serialized after A (**chain**), and B cannot even begin proving until A
  commits + is scanned (Fact 3).

The scheduler assigns each intent the earliest height it can legally land in,
maximizing lane parallelism.

### 4. Proving pipeline (run far ahead)

On admission, enqueue a proving job against the **latest confirmed anchor**.
Because anchors never expire (Fact 1), proofs can be built as far ahead as we
like; the only gate is witness-availability (Fact 3). Pipeline width = prover
throughput. Bounded-concurrency background workers (extension workers / wasm).

### 5. Submitter

Broadcasts proven lane txs immediately; holds chained txs until their dependency
commits and the client rescans (then their witness — and only then their proof —
can be produced). Sets a generous `expiry_height` (Fact 2). Handles mempool
nuances.

### 6. Confirmation watcher + cascade rollback

Scans blocks: resolves projected→confirmed, releases reservations, fires dependent
ops (e.g. swap claims). On a miss (expiry, eviction, reorg), tears down the failed
op **and everything reachable from it in the DAG**, then replans against the
corrected projected ledger — deterministic and idempotent, never double-reserving.

### 7. Swaps as auto-scheduled dependents

A `Swap` in block N auto-enqueues its `SwapClaim` with `earliest-height = N+1`,
gated on observing `BSOD(pair, N)`. The user fires "swap" once; the claim is an
invisible managed follow-up. Many swaps → many independent claims (distinct swap
NFTs) → they batch into one lane in N+1. The 2-block swap floor thus never
_blocks_ the user; it only appears as settlement latency.

### 8. Denomination daemon (manufactures lanes)

Lanes need a supply of disjoint, adequately-sized notes. A background daemon keeps
a target number of spendable "lanes" per common asset, opportunistically
**fanning out** (splitting a fat note into K) when idle or when demand rises. A
fan-out costs one block of warm-up, so the daemon tops lanes up _ahead_ of demand.
This is the piece that turns "wait a block" into "there's always a fresh lane."

## A privacy win that aligns with throughput

Preferring lanes over chaining your own change is also the **more private** choice:
spending unconfirmed change creates an on-chain link and serializes you; drawing
from a pre-fanned pool of independent notes does neither. Throughput and
unlinkability point the same way — so the scheduler's "prefer disjoint lanes" rule
serves both.

## Extension / app split (keep the extension general)

- **Extension = the async transaction engine** (general): NoteLedger,
  ReservationManager, IntentQueue/DAG scheduler, ProvingPipeline, Submitter,
  ConfirmationWatcher, DenominationDaemon — all durable. This is the existing
  `PenumbraSendOp` durable-op pattern **promoted from a single op to a persisted
  DAG of ops** (survives service-worker eviction).
  - API to apps: `enqueue(intent) -> OpHandle`, `OpHandle.status$`, `cancel(id)`,
    `projectedBalance()`.
- **Apps (dex.rotko.net) = UX only**: fire intents, render the optimistic queue
  ("submitted · settling…"), do strategy (TWAP slicing, agent). They never touch
  notes.

Op status stream: `accepted → proving → provable → submitted → confirmed
(→ claimed)`.

## Open questions / next steps

- Confirm the mempool accepts a stream of our lane txs without per-account
  sequencing surprises (nullifier-set only — appears fine).
- Fee handling per lane (each tx pays its own fee note; the denomination daemon
  should account for fees when sizing lanes).
- Target lane count `K` and fan-out policy (static vs. demand-driven).
- Reorg depth assumptions for rollback (Penumbra/CometBFT finality is fast; likely
  single-block).
- Prover throughput budget in-wallet (ties to the halo2/zakura proving work).
