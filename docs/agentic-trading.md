# BYO-LLM Agentic Trading Runtime

Status: design (synthesizes a completed 5-expert review). Documentation only. No code has been written for this yet.

## Executive summary

Zafu (the Chrome MV3 Penumbra wallet) can host a user's own LLM agent - bring-your-own OpenRouter / Ollama / OpenAI, exposed through a single OpenAI-compatible connector. The agent only ever _proposes_ trades. Zafu enforces a deterministic authorization envelope and signs. Execution reuses the existing `mmbot` / `ctm-mm` bots at `/steam/rotko/penumbra-token-factory` (`crates/bin/mmbot`, `crates/bin/ctm-mm`), whose pipeline is `market-state -> compute_signal -> Planner -> pluggable CustodyConfig`. The LLM replaces the `compute_signal` seam; zafu becomes a new `CustodyConfig` variant via Penumbra custody v1. Five decisions below are each already vetted; this doc records them and grounds each in code.

## 1. Architecture

### The bot pipeline we are reusing

`mmbot` and `ctm-mm` already run the loop we want. In `crates/bin/ctm-mm/src/model.rs` the shape is explicit: a `MarketState` snapshot (`model.rs:48-74`) is reduced by `compute_signal(&MarketState) -> Signal` (`model.rs:116`) into a `Signal` of trading floats (`model.rs:14-29`: `direction`, `spread`, `skew`, `size`, `fill_prob`, `adverse_selection`, `certainty`). That `Signal` drives a `Planner` (`penumbra_sdk_view::Planner`, e.g. `mmbot/src/bot.rs:239`), and the resulting plan is signed through a pluggable custody backend.

### The custody seam where zafu slots in

`mmbot/src/config.rs` defines the pluggable seam:

```
pub enum CustodyConfig {
    SoftKms(SoftKmsConfig),
    Other,
}
```

At runtime `bot.rs:75-83` matches on it (`CustodyConfig::SoftKms(cfg) => SoftKms::new(cfg)`), wraps it in a `CustodyServiceServer`, and drives it via a local-gRPC `CustodyServiceClient`. Transactions are built with `penumbra_sdk_wallet::build_transaction(&view, &mut custody, ...)` (`bot.rs:249-252`, `bot.rs:416-419`). Custody is already a swappable service behind a gRPC boundary. `SoftKms` is one variant. **Zafu becomes another variant**: a custody backend that receives the `AuthorizeRequest`, enforces the envelope (Decision 4), and signs with the agent's isolated spend key (Decision 1).

### Two seams, two owners

- The LLM owns the `compute_signal` seam only. It is replaced by "propose an intent" (Decision 3). It never touches keys, view state, or the planner directly.
- Zafu owns the custody seam. Deterministic code expands the intent into a plan, checks the envelope, and signs.

## Decision 1: Isolation is a separate spend key, not a subaccount

A Penumbra subaccount is **not** a security boundary. `crates/core/keys/src/keys/spend.rs` shows a `SpendKey` holds exactly one spend-authorization key: `struct SpendKey { seed, ask, fvk }` (`spend.rs:33-37`), and `PartialEq` compares only the `seed` (`spend.rs:39-43`). An `AddressIndex` merely selects a diversifier for a payment address off the one incoming viewing key - `IncomingViewingKey::payment_address(&self, index: AddressIndex)` (`ivk.rs:31`), with `index_for_diversifier` / `address_index` as the reverse lookup (`ivk.rs:93`, `ivk.rs:105`). All subaccounts of a wallet share one `ask` and one FVK. A compromised agent that can spend from subaccount N can spend from every subaccount, because there is a single spend authority.

The correct boundary is a distinct spend key at a dedicated mnemonic index. `SpendKey::from_seed_phrase_bip39(seed_phrase, index)` derives the spend seed with salt `format!("mnemonic{index}")` (`spend.rs:93-105`), so a different `index` yields a different `ask` and a different FVK from the same mnemonic. This is designed for exactly this: the doc-comment says "This allows us to derive multiple spend authorities from a single seed phrase" (`spend.rs:88-91`).

Consequences:

- **Blast-radius bounding.** The agent's spend authority reaches only what is funded into the agent key. A compromise of the agent (or its LLM) cannot spend the main wallet. The agent's budget is literally what the user transfers into the agent account.
- **Visibility isolation.** A distinct FVK means the agent sees only its own notes. Penumbra view state is FVK-scoped, and zafu's view is built per-FVK: `startWalletServices` constructs `new Services({ fullViewingKey, ... })` and calls `getWalletServices()` to start a sync keyed to that FVK (`apps/extension/src/wallet-services.ts:131-142`). The agent therefore gets its **own view / sync database**, separate from the main wallet's. The agent cannot even observe the main wallet's balances or history.

## Decision 2: Runtime is a v1 in-extension attended loop

v1 runs inside the extension, only while the wallet is unlocked and attended. It reuses two existing, proven patterns.

**Alarm-driven ticks.** The service worker already schedules background work with `chrome.alarms`. `service-worker.ts:413` creates a `blockSync` alarm (30-minute period) and `service-worker.ts:444` handles it to drive `blockProcessor.sync()`. The agent loop reuses this pattern with its own dedicated alarm and its own cadence; it does not piggyback on the 30-minute sync cadence.

**Crash-consistency via a durable op record.** In-flight sends are tracked as `PenumbraSendOp` rows in `chrome.storage.session`. On worker startup the SW scans them and fails any non-terminal op left behind by a dead worker: it marks rows `status: 'error', error: 'interrupted - extension restarted'` rather than leaving them spinning (`service-worker.ts:335-355`). The agent applies the same durable-op discipline: a proposal that was accepted and is mid-build/sign/broadcast is a durable record with a terminal state, so a worker recycle cannot double-execute or silently lose a trade.

**Freshness gate on every tick.** Never plan against a lagging view. The auto-claim daemon already encodes the idiom: it only acts when `latestBlockHeight - fullSyncHeight <= 10` (`apps/extension/src/hooks/penumbra-swap-claim.ts:121-124`). Every agent tick must pass the same freshness check before it is allowed to plan; a stale view means skip the tick, not trade on old prices.

**Auto-lock kills unattended loops.** The `idleCheck` alarm (1-minute period, `service-worker.ts:418`) auto-locks after `autoLockMinutes` of inactivity, removing `passwordKey` and calling `chrome.runtime.reload()` (`service-worker.ts:423-441`). Background sync ticks deliberately do **not** reset the activity timer (`service-worker.ts:392, 406-410`), so a long unattended in-extension agent loop is torn down by auto-lock. This is a feature: v1 is attended by construction.

**Later: an external mmbot-shaped service.** Strategies that need to run for hours or react at block rate do not belong in an MV3 service worker. The v2 path is the external `mmbot`-shaped process with its own `ViewServer`, where zafu is the custody backend (see Architecture). v1 deliberately does not attempt this.

## Decision 3: The DEX contract is intent-level, not signal floats

The LLM does **not** emit the `Signal` floats from `model.rs:14-29`. Those (`direction`, `spread`, `skew`, ...) are internal knobs for a numeric model, not a safe or auditable trade authorization. Instead the LLM emits a typed intent enum:

```
{ swap, twap, dutch_auction, open_position, close, withdraw, hold }
```

Each intent carries economic parameters (`min_output`, `max_slippage_bps`, `expiry`, ...). A deterministic executor expands the intent into a `TransactionPlan`; the envelope (Decision 4) enforces it; then zafu signs. The typed enum is the whole contract surface: anything not expressible as an intent is not expressible at all.

**Slippage is enforced client-side.** A Penumbra swap has no on-chain minimum-output guard. `SwapPlaintext` carries `trading_pair`, `delta_1_i`, `delta_2_i`, `claim_fee`, `claim_address`, `rseed` and nothing else (`/steam/rotko/penumbra/crates/core/component/dex/src/swap/plaintext.rs:28-41`). There is no `min_output` field to protect against an adverse batch price. Therefore `max_slippage_bps` / `min_output` are enforced **client-side, before signing**: the executor simulates each slice against the current book and refuses to sign a slice whose simulated output violates the intent's bound.

**Prefer native Dutch auctions over naive TWAP.** A time-sliced TWAP is many separate on-chain swaps - more transactions, more timing metadata, worse privacy. Penumbra has a native Dutch auction primitive; the action plans already exist in the plan surface (`actionDutchAuctionSchedule`, `actionDutchAuctionEnd`, `actionDutchAuctionWithdraw` in `apps/extension/src/state/tx-validation/assert-valid-plan.ts:117-119`). A Dutch auction is a single on-chain intent that expresses "sell X over this price range", giving better execution privacy than N discrete swaps. The executor prefers it.

**The LLM never emits a claim.** Penumbra swaps are two-phase: swap, then swap-claim. The claim is a mechanical follow-up, not a decision. Zafu already has an auto-claim daemon that detects unclaimed swaps and submits the claim in the background (`penumbra-swap-claim.ts`, `claimUnclaimedSwaps` at `:38`). Claims are also auto-authorized without user interaction: `isSwapClaimOnly(plan)` short-circuits to sign without a popup (`apps/extension/src/ctx/authorization.ts:20-27`), consistent with `assert-valid-plan.ts:114-115` which asserts a swap-claim needs no spend-key authorization. The agent's `swap` / `dutch_auction` intents rely on this existing machinery; there is no `claim` verb in the enum.

## Decision 4: The custody envelope is enforced before authorizePlan, deny-by-default

The envelope lives in `apps/extension/src/ctx/authorization.ts` and runs **before** `custody.authorizePlan`. This is a real change from today's flow: `getAuthorization` currently kicks off signing in parallel with the approval popup - `openWallet().then(custody => custody.authorizePlan(plan))` runs concurrently with the user's `choose` promise (`authorization.ts:39-56`). For the agent path the envelope must be a gate that runs and passes _first_; only then may the plan be signed. Deny-by-default: any plan that the envelope does not affirmatively permit is rejected.

The envelope is enforceable because custody v1 hands us the full plaintext plan. The custody `AuthorizeRequest` carries `pub plan: TransactionPlan` (`/steam/rotko/penumbra/crates/custody/src/request.rs:12`), pre-proof and in the clear. Penumbra even ships a precedent for policy-over-plan custody: the `Policy` trait's `check_transaction(&self, request: &AuthorizeRequest)` (`/steam/rotko/penumbra/crates/custody/src/policy.rs:25-27`) and `AuthPolicy::DestinationAllowList` (`policy.rs:49-55`). The zafu envelope is the browser analogue of that trait.

What the envelope inspects, per action:

- **`SpendPlan`**: `note.value` and `note.address`. Restrict spends to the agent account by resolving the source address's index. Zafu already resolves ownership + account index via `viewClient.indexByAddress({ address }) -> { addressIndex }` (`apps/extension/src/state/tx-approval.ts:106-107`, and `apps/extension/src/routes/popup/home/validate-address/get-address-ownership-info-from-bech32m-address.ts:13`). A spend whose source is not the agent account is denied.
- **`OutputPlan`**: destination address must be controlled by the agent FVK (`isControlledAddress`, dynamically imported in `assert-valid-plan.ts:94-105`). Value returning to the agent account is fine; value leaving it is outflow.
- **`SwapPlaintext`**: `claim_address` must be agent-controlled (this check already exists for swaps at `assert-valid-plan.ts:73-106`); `delta` inputs and `claim_fee` are accounted.
- **`PositionOpenPlan`** and the Dutch-auction actions: reserves committed are accounted against the budget.
- **Fee**: both channels. The transaction fee and `SwapPlaintext.claim_fee` (`plaintext.rs:36`) are separate outflows; cap **both**, per-transaction and per-day.

Two accounting rules:

- **Cap net outflow, not gross spends.** A single swap can spend a large note and return most of it as change to the agent. Gross spend is meaningless; the budget meter is value that leaves the agent's controlled set. Sum outputs/withdrawals to non-agent destinations minus value returning to agent-controlled addresses.
- **`Ics20Withdrawal` is the perimeter.** This is where custody ends and funds leave the Penumbra shielded set entirely. Today it is unguarded: `assert-valid-plan.ts:127` lists `ics20Withdrawal` under "no specific assertions". The envelope adds the checks: `return_address` must be agent-controlled (so a failed/refunded transfer comes back to us) and the destination chain/address must be on an explicit allowlist. Withdrawals count fully against net outflow and the daily cap.

## Decision 5: Security and sandbox

**The agent runs in an opaque-origin sandboxed page.** The extension's internal-sender check requires the extension origin: `assertValidInternalSender` accepts a sender only if `sender.origin === chrome-extension://<id>` (or a worker URL with that origin) (`apps/extension/src/senders/internal.ts:29-65`). A sandboxed page declared with an opaque origin fails `isValidInternalSender` **by construction** - it has no privileged origin, so it cannot call any internal message handler. The sandbox is a hard capability wall, not a convention.

**A 4-verb tool contract is the agent's only capability.** The sandboxed page can do exactly four things, brokered by the privileged side:

1. `get_market_data`
2. `get_bot_positions`
3. `propose_trade`
4. `get_proposal_status`

There is no `send`, no `transfer`, no storage access, no generic fetch to arbitrary origins. The broker validates every call and never forwards keys or plans into the sandbox.

**Sandbox CSP forbids `unsafe-eval`.** The sandbox page's CSP must not allow `unsafe-eval`; a BYO endpoint returning hostile text must not be able to reach code execution.

**Model text is plain-text only in privileged UI.** The top threat is XSS reaching the keyring. Any model-authored string (reasoning, rationale, labels) rendered in a privileged (non-sandboxed) surface is rendered as plain text, never as HTML/markdown that can inject script. Treat all model output as untrusted data.

**BYO endpoint fetched inside the sandbox.** The network call to OpenRouter / Ollama / OpenAI happens inside the sandbox, so the user's API key lives in the sandbox and **never reaches the broker** or the privileged side. The broker sees only the 4-verb traffic.

**Kill-switch and audit.** The kill-switch is broker-side and tears down the sandbox: killing the loop is a privileged action that destroys the sandboxed page, not a request the agent can decline. Every proposal - accepted **and** rejected - is logged service-worker-side, giving a complete audit trail of what the agent asked for and what the envelope allowed.

## Privacy model

- **Local Ollama is the default.** With a local model, the agent's view of the bot account and its strategy never leave the device.
- **Cloud providers carry an explicit disclosure.** Choosing a cloud endpoint (OpenRouter / OpenAI) means the agent's bot-account positions and its strategy prompt leave the device to that provider. This is surfaced as an explicit, unmissable disclosure at the point the user selects a cloud endpoint, not buried in settings.
- **The agent sees only the isolated agent account.** By Decision 1 the agent has its own FVK and its own view database. It cannot see the main wallet's balances, addresses, or history - not the LLM, not the tool contract, not the market-data feed. Even a fully cloud-hosted, fully compromised agent leaks only the agent account, which is bounded to its funded budget.

## General primitive, apps specialize

Zafu stays a general primitive. The wallet provides: the isolated key derivation (Decision 1), the custody envelope and signing (Decision 4), the sandbox and 4-verb broker (Decision 5), and the durable attended loop (Decision 2). It does not embed a trading strategy, a market opinion, or a specific model. Strategies, prompts, and model choices are app-level / user-level specialization layered on top of these primitives. The DEX intent enum (Decision 3) is the stable, minimal contract between the two layers.

## v1 scope

- Run only while the wallet is unlocked and attended (Decision 2; enforced by auto-lock).
- Separate agent spend key at a dedicated mnemonic index, with its own FVK and view DB (Decision 1).
- Opaque-origin sandbox with the 4-verb tool contract; BYO OpenAI-compatible connector; local Ollama default (Decision 5).
- Deny-by-default custody envelope with net-outflow and dual-fee caps, enforced before signing (Decision 4).
- **First built-in strategy: TWAP / Dutch auction.** One concrete strategy that exercises the whole `propose -> validate -> sign -> execute` loop end to end, preferring the native Dutch auction, proving the seams before any second strategy is added.

## Non-goals (v1)

- No hours-long or block-rate unattended operation in the extension. That is the external mmbot-shaped v2 service.
- No agent access to the main wallet. Ever. The isolation boundary is cryptographic, not policy.
- No on-chain slippage reliance. Slippage is client-side by necessity (Decision 3).
- No `send` / `transfer` / storage / generic-fetch verbs exposed to the agent. The tool contract is exactly four verbs.
- No rich (HTML/markdown) rendering of model text in privileged UI.
- No LLM-emitted swap claims. Claims stay on the existing auto-claim daemon.
- No agent authority over validator votes, governance, or account structure - the envelope permits only the trading action set.
