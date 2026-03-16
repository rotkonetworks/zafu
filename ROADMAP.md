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
