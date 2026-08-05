# Release testing status — NU6.3 / Ironwood

What is verified, how, and what is not. Written so a release decision can be
made from evidence rather than recollection, and so nobody has to re-derive
today's findings from a chat log.

Last updated against `zafu@7609f63a` / `zcli@fce00a8`.

## Verified against the chain or against consensus source

| claim                                                               | evidence                                                                                                                                                                                          | pinned by                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Turnstile migration is consensus-valid                              | mainnet block 3,436,797, tx `e0932c3f91d1a14f…` — built by this codebase, mined and validated                                                                                                     | `mainnet_consensus_fixtures.rs`                      |
| `Anchor::empty_tree()` is accepted for output-only ironwood bundles | computed constant `ae2935f1…` equals the anchor in that mined tx; zebra checks `shared_anchor` with no exemption for spendless bundles (`zebra-state/.../anchors.rs:137`)                         | `empty_tree_anchor_matches_the_one_mainnet_accepted` |
| ZIP-317 counts ironwood actions                                     | zebra `zebra-chain/src/transaction/unmined/zip317.rs` adds `n_actions_ironwood` into `logical_actions`                                                                                            | `turnstile_fee_matches_the_mined_value_balances`     |
| Turnstile fee arithmetic                                            | mined value balances: orchard `+385,000`, ironwood `−365,000` → 20,000 zat accepted                                                                                                               | same                                                 |
| **z→t withdrawal from ironwood is consensus-valid**                 | mainnet tx `6d91730e99dcd192…`, height 3,437,366: V6, versiongroupid `d884b698`, 2 ironwood actions, valueBalance `+65,000`, one transparent output of 50,000 — built by zafu, accepted and mined | —                                                    |
| z→t fee arithmetic                                                  | that tx paid 65,000 − 50,000 = **15,000 zat**, exactly `5000 × (max(1,2) + 1)`                                                                                                                    | —                                                    |
| ZIP-317 transparent inputs are size-derived                         | `ceil(148n/150) == n` only while `2n < 150`; 75 inputs = 74 actions                                                                                                                               | `zip317_transparent_input_actions_are_size_derived`  |

## Browser smoke test

The built extension was loaded unpacked into headless Chromium (150.0.7871.186)
and driven over the DevTools protocol:

```
chromium --headless=new --no-sandbox --remote-debugging-port=9334 \
  "--remote-allow-origins=http://127.0.0.1:9334" \
  --load-extension=apps/extension/dist \
  --disable-extensions-except=apps/extension/dist
```

Result: the service worker registers, `page.html` boots and routes to
onboarding, the DOM paints (368 chars: the three entry paths and the
keys-stay-local line), `offscreen.html` loads as the headless proving document,
and **every surface reports zero runtime errors and zero exceptions**.

A full wallet was then created through the real UI in that browser — seed
generated, backup acknowledged, Zcash enabled, password set, "wallet ready" —
and the popup opened against the live mainnet zidecar. It rendered:

```
balance | not yet known | still scanning — the sync line below shows how far
syncing 99% · ~2 min
nomt ✓ · ligerito server catching up · scanning notes 99%
3,430,600 / 3,437,446
ironwood 0 ZEC | orchard …
```

That directly verifies the two reported failures are fixed, in a browser, on a
real chain:

- the balance reads `not yet known` **with an explanation**, not the bare `—`
  that read as "your money is gone"
- `syncing 99%` and `scanning notes 99%` **agree**. The reported
  "syncing 100% / scanning notes 0%" contradiction is gone, because the
  headline no longer falls back to the server's ligerito percentage when the
  wallet has no scan progress of its own.

After a browser restart the wallet correctly returned to the lock screen, was
unlocked with the password, and every main surface was navigated and read:

| screen     | rendered                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------- |
| home       | `balance: not yet known` + explanation, `syncing 32%` / `scanning notes 32%` **agreeing** |
| send       | `spendable: 0 ZEC` + `no zec yet - receive first`                                         |
| pool notes | `ironwood - 0 notes / 0.0000 ZEC`, `no ironwood notes yet`                                |
| receive    | shielded address with the "they can't see your other transactions" framing                |

Two more fixes verified on screen there: the send form says **spendable**, not
"balance" — the distinction that had it advertising unspendable orchard funds —
and the pool subtotal counts only unspent notes.

What this does and does not establish. It establishes that the bundle loads,
the service worker registers, React mounts, and nothing throws on boot — a real
smoke test, and it is repeatable in CI. It does NOT establish the paths that need VALUE or HARDWARE: a pending-send
row, a failed/expired send, a rescan confirmation, and the cold-sign round trip
all need a funded wallet and, for cold signing, a physical device. Those remain
unexercised — and the cold-send bookkeeping fix is the most structurally
invasive change of the release, so it deserves one real round trip before
shipping.

## Verified locally, never broadcast

These pass a full build → prove → sign → extract, which re-verifies the proof
and every signature. That is **not** consensus acceptance. Zebra exposes no
dry-run validation RPC (`getmempoolinfo` / `getrawmempool` only), so the only
way to close these is to broadcast.

- **t→z shielding into ironwood** — `shielding_ironwood_v6.rs`, 7 tests

Cost to close: one shielding send. z→t is now closed (see the table above).

Risk if shipped unbroadcast: a rejected transaction, not a loss of funds — the
failure mode is the network refusing it, and nothing moves. The two assumptions
that would have made rejection likely (ironwood ZIP-317 weighting, empty-tree
anchor) are both now confirmed above, which materially lowers the risk.

## Known-open, by category

**Trust model.** The backend badge says `partial`, not `trustless`, and that is
accurate. Merkle paths for nullifiers and commitments are verified locally and
are now bound to the batch root and to the request set. But the Ligerito header
proof carries **no constraint system**: the roots it "proves" are values the
prover chose and absorbed into its own transcript, so nothing binds them to
consensus, and block/action omission is undetectable from a single server.
Cross-endpoint tip comparison is now wired (`workers/cross-verify.ts`) and
catches a server reporting a chain state no one else agrees with — it does not
make the wallet trustless. A real fix is a design project.

**Ledger.** Ships flag-off (`HARDWARE_WALLET_ENABLED = false`) and must stay
that way. It cannot work on mainnet with any released app, for two independent
reasons, both inside Ledger's own SDK/firmware: the signer kit sends the NU6.3
branch id, which no released app-zcash recognises (`6a80`); and its
`SignTransactionCommand` frame shape mismatches what the app requires
(`6700`), at every height. Device-proven against Speculos with app-zcash 3.6.0.
Shielded additionally needs app ≥ 3.8.0, which is not publicly released.

**FROST multisig.** Sends refuse post-NU6.3 rather than building something
unsignable — the ironwood PCZT builder emits no sighash/alphas, so FROST would
run zero signing rounds. Co-signers still **cannot verify the fee**: value
conservation needs `value_balance` plumbed through `frost_inspect_pczt_outputs`
and a wasm rebuild. A test named `DOCUMENTS THE HOLE` marks the spot.

**Privacy.** Proof queries are padded with decoys (anonymity set 3). Be clear
about what that buys: nullifier protection is _retrospective only_ — when the
user spends, the real nullifier reaches the chain and the decoys never do, so an
operator can work backwards. What is destroyed is the prospective watchlist.
Decoy stability also has a hole: the seed lives in IndexedDB `meta`, so clearing
the cache re-rolls decoys while real notes stay fixed.

**Not merged, blocked externally.** The ZID commit on `fix/privacy-p0` moves the
license check to `POST /license`; `zpro.rotko.net` does not serve that yet, and
the error path treats any non-ok response as unlicensed, so merging first would
silently drop every paying user to free. `license.zafu.pro` does not resolve.

## How to run the tests

Rust — **the cfg flag is not optional**. Without it the ironwood tests compile
to nothing and report `0 tests`, which reads as passing:

```
RUSTFLAGS='--cfg zcash_unstable="nu6.3"' cargo test -p zafu-wasm --release
```

Extension, from `apps/extension`:

```
pnpm exec tsc --noEmit && pnpm exec eslint src && pnpm build && pnpm test
```

Ledger device tests skip unless Speculos answers; they cannot pass vacuously.
Build recipe is in the header of `src/ledger/speculos.ts`.

## Wasm

`packages/zcash-wasm/` and `apps/extension/public/zafu-wasm/` are **prebuilt
blobs checked into this repo**. Rust changes do not reach the extension until
both are refreshed, and a stale copy caused a live failure on 2026-08-05. See
`packages/zcash-wasm/BUILD_PROVENANCE.md`; verify all copies are byte-identical
and that the shared imported memory survives, or rayon proving dies.
