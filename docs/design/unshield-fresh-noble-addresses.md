# Fresh, never-reused transparent addresses for private unshielding

> **Chain-generic, Noble-only for now.** Noble is currently the _only enabled_
> IBC channel (the veil `SUPPORTED_CHAINS` config), so today every unshield goes
> there - but nothing below is Noble-specific. All derivation, tracking, and UI
> key off the **destination chain** (its bech32 prefix + SLIP-44 coin type), so
> opening a new channel or recovering an old one is a config change, not a code
> change. Do NOT hardcode "Noble" in labels or logic - render the chain's own
> `displayName`, and derive with the chain's coin type (most cosmos chains use
> `118'`, but not all - carry it per chain rather than assuming).

## Goal

Unshielding Penumbra assets to a transparent chain (to offramp via an exchange
or CCTP - Noble today) must not leak a linkable identity. Two linkage risks:

1. **Reuse across unshields** - if every unshield lands on the _same_ transparent
   Noble address, all of a user's exits are trivially linked to each other.
2. **Direct-to-exchange** - unshielding straight to an exchange deposit address
   ties the Penumbra exit to a KYC'd account in one hop.

The fix is a standard HD pattern: each unshield goes to a **fresh receive
address the user controls**, used exactly once, then swept onward. On-chain,
those addresses are unlinkable to anyone without the wallet's extended key.

## Crypto foundation (this is what makes it cheap)

The zigner already derives cosmos keys at BIP44
`m/44'/118'/account'/0/address_index` via
`derive_cosmos_key(seed, SLIP0044_COSMOS, account_index, address_index)`
(`zigner/rust/signer/src/lib.rs`). Two facts decide the whole design:

- `account'` is **hardened** - you cannot derive sibling accounts from a public
  key. So we do NOT vary the account for freshness.
- `.../0/address_index` is **non-hardened** - given the _account-level extended
  public key_ `m/44'/118'/account'`, anyone can derive `.../0/i` for all `i`
  **without the private key**.

So: export one account **xpub**, and zafu can derive unlimited fresh receive
addresses locally; the zigner signs each with its `address_index`. No new
elliptic-curve code in the signer - `derive_cosmos_key` already takes the index,
it is just hardcoded to `0` today.

## Zigner changes (firmware)

1. **Export the account xpub.** New export (or extend `export_cosmos_accounts`)
   returning the extended public key for `m/44'/118'/account'` (33-byte
   compressed pubkey + 32-byte chain code, base58 `xpub...` or raw). New FFI
   `export_cosmos_xpub(seed, account_index, network)` + a "Cosmos xpub" export
   screen. The xpub is public; safe to show as a QR.
2. **Sign at an address_index.** `CosmosSignRequest` (`signer.udl`) currently has
   `account_index` but **no `address_index`** - add it, and thread it into the
   `derive_cosmos_key(..., address_index)` call in `sign_cosmos_transaction`
   (replacing the hardcoded `0`). The sign screen MUST render the derived address
   so the operator confirms they are signing for the expected receive address.
3. Bump the cosmos export/sign QR format version; keep parsing back-compatible
   (absent `address_index` = 0, current behaviour).

## Zafu changes (extension)

1. **Store the xpub** in the wallet's `insensitive` map at import (next to the
   existing `cosmosAddresses`), e.g. `cosmosXpub: { accountIndex, xpub }`.
2. **Derive fresh addresses.** Add a helper (secp256k1 non-hardened child
   derivation from the xpub - pin `@scure/bip32` `HDKey.fromExtendedKey(...)
.deriveChild(0).deriveChild(i)`, then `bech32` with the chain prefix). Verify
   the derived index-0 address matches the imported `cosmosAddresses[noble]` as a
   self-check that the xpub + path are correct before trusting derivation.
3. **Track used indices** per wallet (persist a `nextCosmosIndex` counter or a
   used-index set in storage; survives restarts so we never reuse across
   sessions). Honour a **gap limit** (e.g. 20) for recovery scans.
4. **Unshield flow** (rename "IBC withdraw" -> **"Unshield"**, showing the
   destination chain's name): auto-pick the next unused `address_index`, derive
   its address on the destination chain, withdraw to it, mark the index used. The
   user never sees or pastes an address - "Unshield 50 USDC" is the whole
   interaction.
5. **Send flow (Noble -> exchange).** Already lives in the Send section on the
   Noble network. When spending from a derived address, include its
   `address_index` in the `CosmosSignRequest` QR so the zigner signs the right
   key. Balances must be summed across derived indices (see recovery).

## UX

- **Unshield to {chain}** = Penumbra shielded -> a fresh, self-controlled address
  on the selected destination chain. Label uses `chain.displayName` (today only
  Noble is selectable). No address handling.
- **Send** = destination chain -> exchange (or CCTP). Signs with the address's
  index via the zigner QR (watch-only).
- The two are deliberately separate actions; the "put the transparent send in
  Send" the user asked for is exactly this - Send already handles that leg.

## Edge cases

- **Recovery / balance discovery.** On re-import (or a new device), scan
  `address_index = 0..gap_limit` for balances so funds parked on a fresh address
  aren't lost. Advance `nextCosmosIndex` past the highest funded index.
- **Watch-only signing.** Noble accounts are watch-only (imported off the
  zigner), so every Noble send is signed on the device via QR. The `address_index`
  in the request is what lets the device reach the right key.
- **IBC timing.** The unshield IBC transfer takes several blocks to land; the
  Send step waits for arrival. Surface the pending transfer.
- **xpub absent** (older imports, or user declined the export): fall back to the
  single imported address WITH an explicit reuse warning, or block auto-fresh and
  require a manually pasted fresh address. Do NOT silently reuse.
- **Exchange network.** Many exchanges want USDC on Ethereum/Base, not Noble.
  Then the onward hop is Noble -> CCTP -> Ethereum -> exchange; out of scope here
  but the reason Noble is the right single gateway.

## Security notes

- The xpub is **public** and safe to store locally, but anyone who holds it can
  link all derived addresses to each other. Keep it in the wallet's local
  encrypted store; never transmit it. On-chain, the addresses stay unlinkable to
  third parties (they don't have the xpub).
- Hardened `account'` means a leaked xpub cannot reach the private keys or other
  accounts - it only reveals this account's receive-address set.

## Build order

1. zigner: `address_index` in `CosmosSignRequest` + sign path (small, Rust-
   testable) - unblocks signing derived addresses.
2. zigner: `export_cosmos_xpub` FFI + export screen (mobile UI).
3. zafu: xpub storage + `@scure/bip32` derivation + index tracking + self-check.
4. zafu: unshield auto-fresh-address; Noble-send passes `address_index`; balance
   scan across indices.
5. Relabel "IBC withdraw" -> "Unshield" (show the destination `chain.displayName`
   dynamically - never the literal string "Noble").

Interim (already done): the reuse-promoting "use my Noble address" button was
removed - offering one reused address is worse than offering none.
