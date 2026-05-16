# Cosmos chains as Penumbra sub-wallets

**Status:** proposed · **Owner:** rotko · **Date:** 2026-05-04

## Goal

Unify Zafu's Penumbra and Cosmos UX. When the user is in Penumbra mode,
the home view should show both:

- The shielded Penumbra balance (the canonical view today)
- The user's **unshielded Cosmos balances** on each chain Penumbra has an
  IBC connection to (Cosmos Hub, Noble, Osmosis, Axelar, Stride, Neutron,
  Injective, Celestia, dYdX) — rendered as **sub-wallets** under the
  selected Penumbra wallet, not as a separate "Cosmos" mode.

Web pages (veil DEX) should also be able to detect Zafu as a Cosmos
wallet so the deposit/shield flow can sign IBC transfers without the user
installing Keplr or Leap.

## Today's state

| Layer | Penumbra | Cosmos |
|---|---|---|
| Key derivation | full FVK + spend key flow | already exists in `state/keyring/`, used internally for `cosmos-sign.tsx` |
| Web injection | `window[Symbol.for('penumbra')]` via two content scripts (ISOLATED + MAIN) | none — pages can't see Zafu as a Cosmos wallet |
| Balance display | Penumbra view-server sync; balances in popup | not surfaced under Penumbra wallet view; only seen during a Cosmos send/sign flow |

## Target

### A. Wallet model

For each Penumbra wallet stored in `state/wallets.ts`, derive deterministic
Cosmos addresses for the supported chains. Store them as **sub-wallets**
keyed by `chain_id`. The user's spend key seeds both Penumbra and the
Cosmos derivations — no separate import.

```
PenumbraWallet {
  spend_key
  fvk
  cosmos_subwallets: {
    [chain_id]: { address, derivation_path }
  }
}
```

### B. Home view rendering

`routes/popup/home/index.tsx`: under the selected Penumbra wallet, render
a list:

```
[ ◉ Wallet "main"           ]   ← selected Penumbra wallet
   shielded                3.14 UM
   ───
   ↓ unshielded
   Cosmos Hub             0.84 ATOM
   Noble                  127 USDC
   Osmosis                12.5 OSMO
   ...
```

Each unshielded row is clickable → opens a "shield this asset" flow that
pre-fills the IBC transfer to Penumbra.

### C. Cosmos balance fetcher

New `state/cosmos-balances.ts` module:

- For each `(chain_id, address)` tuple, poll the corresponding Cosmos REST
  or RPC endpoint (`/cosmos/bank/v1beta1/balances/{address}`) using the
  RPC list already in `apps/extension/src/state/cosmos-balances/...`
  (we have endpoints from the Penumbra registry and the existing
  `cosmos-endpoints.ts` in veil — port that list here).
- Cache in memory with a 30s stale time; refetch on focus and on chain
  reconnect.
- Expose a hook `useCosmosSubwalletBalances(walletId)` that returns
  `{ chain_id, asset, amount, usd_value? }[]`.

### D. Web injection: Cosmos API

Add a new content script `injected-cosmos-global.ts` that mirrors
Keplr's API surface (`enable`, `getOfflineSigner`, `getKey`, `signAmino`,
`signDirect`, `experimentalSuggestChain`). The script:

- Reads `chrome.runtime.id` from the existing dataset bridge (same
  ISOLATED/MAIN pattern as Penumbra injection).
- On `enable(chainIds)`, asks the popup for permission per chain, then
  returns the addresses for the approved chain set.
- On `getOfflineSigner(chainId)`, returns an OfflineDirectSigner that
  forwards each `signDirect` call as a message to the service worker,
  which reuses the existing `cosmos-sign` UI flow.

Inject as `window.zafu` (preferred) and **also** alias to `window.keplr`
when no real Keplr is detected — that gives veil's existing `useChain()`
calls auto-discovery without any veil-side code change.

### E. veil-side cosmos-kit adapter

Once D ships, add `apps/veil/src/features/cosmos/zafu-wallet.ts` that
implements cosmos-kit's `MainWalletBase`:

- Detection: `window.zafu?.cosmos`
- Wallet adapter: thin shim around the Keplr adapter pattern (the API is
  intentionally Keplr-compatible)
- Register in `chain-provider.tsx` alongside `keplrWallets`,
  `leapWallets`

If we go with the `window.keplr` alias path in D, this step is optional —
cosmos-kit will pick Zafu up via the existing Keplr adapter.

## File-level work

### Zafu

```
apps/extension/src/
  state/
    cosmos-balances.ts                  # NEW: fetcher + cache
    cosmos-rpc-endpoints.ts             # NEW: per-chain endpoint list
    wallets.ts                          # MODIFY: derive cosmos subwallets on wallet create
  hooks/
    use-cosmos-subwallet-balances.ts    # NEW
  routes/popup/home/
    cosmos-subwallet-row.tsx            # NEW: one row per chain
    index.tsx                           # MODIFY: render subwallet rows under selected wallet
  content-scripts/
    injected-cosmos-global.ts           # NEW: window.zafu.cosmos + window.keplr alias
    injected-session.ts                 # MODIFY: also bridge for cosmos
    message/cosmos-connection.ts        # NEW: CONNECT/SIGN_DIRECT/etc. messages
  message/listen/
    external-cosmos-enable.ts           # NEW: enable(chainIds) handler
    external-cosmos-sign.ts             # NEW: forward to existing cosmos-sign UI
  manifest.json                         # MODIFY: add injected-cosmos-global.js to content_scripts
```

### veil

```
apps/veil/src/features/cosmos/
  zafu-wallet.ts                        # NEW (only if not using Keplr alias)
  chain-provider.tsx                    # MODIFY: register zafu wallets
```

## Open questions

1. **Derivation path** — Penumbra spend key is hierarchical, but the
   current Penumbra-protocol scheme (via `pcli`) doesn't define a Cosmos
   derivation. Options: (a) reuse the BIP-39 seed if Zafu still has it
   in encrypted storage, derive standard Cosmos paths; (b) one-shot at
   wallet create time, store derived addresses + a separate Cosmos
   private key encrypted with the same password. (a) is cleaner if the
   seed is recoverable.

2. **Zigner cold-signing for Cosmos** — multi-network architecture has
   Cosmos listed as 🔧 Planned. The first version of this can use
   Zafu's hot signing (Zigner integration is a follow-up).

3. **Approved chain list scope** — keep it to the 9 Penumbra-IBC chains
   for v1, even though Zafu could in principle support any Cosmos
   chain. Avoids becoming a generic Keplr clone.

4. **USD valuation of unshielded balances** — we have a USDC numeraire
   from the Penumbra registry. For each unshielded asset, route price
   through the existing veil `dex.rotko.net/api/candles` to get USD; or
   ship a small price oracle in Zafu. v1: surface raw amounts only.

## Out of scope

- Mobile wallet support (WalletConnect)
- Generic Cosmos chain registration via `experimentalSuggestChain`
- Cosmos staking / governance UI in Zafu
- Re-architecting Zafu's Penumbra view-service to also index Cosmos
  events (Cosmos balances stay live-queried, not indexed locally)
