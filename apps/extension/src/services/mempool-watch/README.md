# mempool-watch

Opt-in service that polls a zidecar endpoint for the current mempool,
trial-decrypts every Orchard compact action against the wallet's IVK in
the worker, and emits `mempool-update` events for matches (incoming) and
nullifier-set matches (pending spends).

See `docs/services-pattern.md` for the `(Service) => Service` composition
model; this module mirrors `services/memo-sync/` exactly.

## Design

Service = `MempoolFetcher: (walletId, ctx) => AsyncIterable<MempoolSnapshot>`.

Filters (call-time, outermost first):
- `withPoll(intervalMs, jitterMs, phaseAlign)` — repeats inner on cadence.
  Wall-clock phase-aligned so all clients fire on the same second-since-epoch
  slot; jitter perturbs around the slot. Without phase-align, per-client
  startup phase is a stable fingerprint.
- `withDedup()` — suppresses snapshots whose entry-hash set hasn't changed,
  so trial decryption doesn't re-run on identical bytes every poll.
- `withReconnect(initialDelayMs, maxDelayMs, maxAttempts)` — exponential
  backoff on transport errors. Inner to dedup so a transient blip doesn't
  reset dedup state.

Base = `zidecarMempoolFetcher(ZidecarClient)`. Single round-trip per
invocation; abort signal threaded through `fetch` so shutdown is prompt.

Strategy = closed enum `'off' | 'on'`. `isMempoolWatchEnabled(setting,
backend)` is the single-source-of-truth gate used by every layer (UI,
auto-sync hook, worker shim, worker `case 'sync'`, worker `runSync`).
Mempool watch is only meaningful on `backend === 'zidecar'`; on other
backends the helper returns false and no watcher is spawned.

## Privacy contract

- **Opt-in.** Default is `'off'`. Enabling puts the wallet in the small
  set of users actively watching mempool — that set is itself an
  anonymity-set partition. Users opt in with the honest sub-line "your
  indexer learns when you're online."
- **Phase-aligned cadence.** Wake-ups target wall-clock multiples of the
  interval; per-user phase offset doesn't persist across reconnects.
- **No active probe.** Backend selection is declarative (see
  `state/keyring/zcash-backend.ts:isZidecarEndpoint`). A probe of a
  zidecar-only RPC against an arbitrary endpoint would itself be a
  unique-to-zafu request signature.
- **`mempool-update` is match-conditional.** The event fires only when
  the wallet found at least one match. Consumers MUST do constant-effort
  work regardless of payload contents (see contract comment in
  `state/keyring/network-worker.ts` next to the dispatch).
- **Trial decryption is local.** Keys never leave the worker; the binary
  buffer fed to `scan_actions_parallel` carries only the compact action
  bytes from the wire, never key material.
- **Action-buffer hardening.** Malformed actions are rejected, not zero-
  padded. A hostile zidecar can't desync the buffer. `MAX_MEMPOOL_ACTIONS`
  caps allocation. Orchard compact-note version byte (`0x02`) is
  checked; forward-compat plaintexts (e.g. Orchard-ZSA at NU7) are
  refused until support lands.

## Joint-fingerprint note (cross-feature)

A wallet that has both **memo-sync** and **mempool-watch** active will
issue two distinct polling patterns against the same endpoint:

- memo-sync runs on user demand (bucket fetches when the user clicks
  "sync memos"), in bursts.
- mempool-watch polls continuously at ~10s ± jitter, wall-clock aligned.

The two are independent and not co-scheduled. The reason is that they
have different cadence classes — bursty vs steady — and any attempt to
unify them would either slow mempool-watch (worse UX) or inflate memo-
sync traffic (more bandwidth + larger anonymity-set cost). The
correctness invariants of each (memo bucket randomization, mempool phase
alignment) are designed assuming independence.

A zidecar operator who observes a wallet's traffic sees the union of the
two patterns. Anonymity-set-wise, **both** patterns must be present to
distinguish a "memo-sync + mempool-watch" wallet from a "memo-sync only"
wallet from a "mempool-watch only" wallet — but the toggle settings are
already user-visible knobs, so this is no worse than the toggles
individually leak.

If future work introduces a third continuous-poll service, this
calculation changes. A unified scheduler (single phase-aligned timer
that fans out to multiple service consumers) becomes worthwhile when
there are ≥2 continuous-cadence pollers.

## Tests

- `filters/poll.test.ts` — phase-align, jitter symmetry, abort responsiveness
- `filters/reconnect.test.ts` — backoff, success-resets-attempt, abort during sleep
- `filters/dedup.test.ts` — first-yield-always, suppress-identical, persist-across-invocations
