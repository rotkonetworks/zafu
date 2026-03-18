# zafu wallet — roadmap

## encrypt user data at rest
all user-entered data stored in `chrome.storage.local` should be encrypted with the master password key. currently only vault `encryptedData` and penumbra custody boxes are encrypted. contacts, recent addresses, and other user data are stored in plaintext.

- contacts → encrypt with session key on save, decrypt on unlock
- recent addresses → same
- dismiss lists, preferences → same
- storage schema: keep keys readable, encrypt values as BoxJson

## authentication options
offer opt-in stronger auth beyond the current password:

- **TOTP** — time-based one-time password (google authenticator style)
- **FIDO2/WebAuthn** — hardware key or biometric (yubikey, fingerprint)
- these are additive layers on top of the master password, not replacements
- unlock flow: password → optional 2FA challenge → session key

## hardware wallet support
vault types `ledger`, `trezor`, `keystone` are defined in `KeyType` but not implemented.

- ledger: USB HID via WebHID API (chrome extension compatible)
- trezor: trezor-connect SDK
- keystone: QR-based signing (similar to zigner flow)
- each needs a signing filter in the custody layer + UI flow

## per-wallet penumbra sync
`fullSyncHeight` is currently a global key overwritten by whichever wallet is syncing. should be per-wallet (`fullSyncHeight_${walletId}`) so switching wallets shows correct sync state without waiting for resync.

## zcash unified full viewing key (UFVK) for seed wallets
seed wallets derive zcash keys on-the-fly in the worker. a stored UFVK per seed vault would enable watch-only balance display without unlocking, and consistent wallet record linking.

> **open question:** do we want this? a stored UFVK is readable without the password. if the service worker is compromised or a site abuses externally_connectable, it could enumerate balances and transaction history silently. current mnemonic path requires unlock to derive anything.

## stealth mode — opt-in provider injection

currently `injected-penumbra-global.js` runs on every page via content_scripts. this announces "a penumbra wallet is installed" to every site — a fingerprinting signal. the actual FVK/data is gated behind connected sites approval, but the presence alone is metadata.

- add privacy setting: "announce wallet to websites" (default: **off**)
- when off: no content script injection. sites can't detect the wallet.
- when on: current behavior. sites can call `connect()` → approval popup.
- dApps that need wallet detection show "install Zafu" link instead of auto-detecting.
- per-site override: user can enable injection for specific origins only.

this is a differentiator vs MetaMask/Keplr/Prax which all inject unconditionally.

## proving performance — SIMD field arithmetic + precomputed MSM

current: ~12-15s halo2 proving with multithreaded rayon + WASM SIMD128. the bottleneck is multi-scalar multiplication (MSM) on pasta curves.

- **SIMD-optimized pasta field arithmetic** — fork `pasta_curves` crate, add WASM SIMD128 intrinsics for 255-bit field multiplication. pasta fields use 4x64-bit limbs; SIMD128 gives 2x64-bit lanes → ~1.5-2x speedup on field ops. requires `core::arch::wasm32` SIMD intrinsics (i64x2_mul, i64x2_add, etc).
- **precomputed MSM tables** — the halo2 prover uses the same generator points (circuit-specific) every time. precompute windowed multiplication tables and store in WASM memory (~8MB per circuit). skip table setup on each proof → ~20-30% speedup on MSM phase.
- combined: potential ~2-3x total proving speedup (target: <5s per transaction)
