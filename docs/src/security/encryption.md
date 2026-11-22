# encryption at rest

zafu encrypts sensitive wallet data in chrome.storage.local using AES-256-GCM
with a key derived from the user's password via PBKDF2.

## what is encrypted

every value under these storage keys is sealed before it is written
(`ENCRYPTED_KEYS` in `apps/extension/src/state/encrypted-storage.ts`):

- `penumbraWallets`, `zcashWallets` - viewing keys and addresses. viewing keys
  reveal full transaction history; no viewing key is ever stored in plaintext.
  `zcashWallets` also carries FROST multisig wallets and their secret share.
- `contacts`, `recentAddresses`, `dismissedContactSuggestions`,
  `diversifiedAddresses`, `yourAddresses` - who you pay and your own addresses
- `messages`, `peopleRooms`, `peopleThreads`, `peopleInvites` - memos, chats and
  the room keys that open them
- `frostRelayIdentities` - each multisig group's relay key (see
  [frost](frost.md)); it also opens the retired group chat's history
- `groupChats` - that retired history, still sealed, read by nothing
- `passwordLogins`, `passkeyGrants` - saved logins and which sites may use your
  passkeys
- `openBuy`, `openSwaps`, `openPayments`, `zecLp` - buys, swaps, payments and
  liquidity in flight (deposit addresses, memos, fresh addresses)
- `sentKey` - the key that seals the zcash worker's own send records
- `txNotes` - your notes on transactions
- `netContacted` - what zafu contacted lately, kept on this computer only
- `zcashMeApiKey`, `netProxyLogin` - your own api key and proxy login

your seed phrase is sealed separately: each vault in `vaults` keeps its secret
as a `Box` sealed by the same password key, and only the vault's public facts
(name, kind, account, device) sit beside it in plaintext. when the zcash worker
needs the vault key to sign, the page wraps it to a one-time key the worker
issued (ECDH P-256, HKDF, AES-GCM), so nothing readable crosses the extension's
message bus.

not encrypted:

- `knownSites` - origin approvals (origin, choice, date). no private data, and
  read by a package that has no session key.
- `passwordKeyPrint` - the salt and verification hash checked at unlock (see
  [key print](#key-print)). a verifier, not a secret.
- settings the egress policy compiles from (enabled networks, endpoints, which
  destinations you allowed or blocked, the proxy address), which must be
  readable while zafu is locked
- `activeWalletIndex`, `activeZcashIndex` and similar non-sensitive config

## key derivation

password-based key derivation uses PBKDF2 with the following parameters:

- **algorithm**: PBKDF2
- **hash**: SHA-512
- **iterations**: 210,000
- **salt**: 128-bit random (16 bytes), generated once at wallet creation
- **output**: AES-GCM key, 256-bit

the salt is stored in a `KeyPrint` alongside a verification hash. the
verification hash is computed by exporting the derived CryptoKey to raw bytes
and hashing with SHA-256. this hash is used during unlock to verify the password
without attempting a trial decryption.

password verification uses constant-time comparison to prevent timing attacks.
all bytes are compared regardless of mismatch position.

## AES-256-GCM encryption

each encryption operation:

1. generates a fresh 12-byte (96-bit) random nonce via `crypto.getRandomValues`
2. encrypts the plaintext with AES-256-GCM using the derived key and nonce
3. returns a `Box` containing the nonce and ciphertext

the `Box` class holds `(nonce: Uint8Array, cipherText: Uint8Array)`. decryption
requires the same nonce and key.

the at-rest encryption layer uses only the Web Crypto API (`crypto.subtle`). no
third-party cryptography libraries are involved in sealing storage. (other
layers - the zid messaging channel and the [post-quantum](threat-model.md) KEM - do
bundle third-party libraries (`@noble/*`); this note is scoped to
storage-at-rest.)

## storage format

encrypted values are stored as a JSON wrapper:

```json
{
  "encrypted": {
    "nonce": "<base64>",
    "cipherText": "<base64>"
  }
}
```

the `isEncryptedWrapper` function checks for the `{ encrypted: BoxJson }` shape
to distinguish encrypted data from legacy plaintext. if storage contains data
that does not match this wrapper, it is treated as stale and ignored.

## session key lifecycle

the derived AES-256-GCM CryptoKey is stored in `chrome.storage.session` under
the `passwordKey` key as an exported JWK. session storage is scoped to the
extension and cleared when the browser closes.

- **locked state**: no `passwordKey` in session storage. reads return null.
  writes are silently skipped with a console warning.
- **unlocked state**: `passwordKey` is present in session storage. reads decrypt
  on demand. writes encrypt before persisting to local storage.

the `Key` class wraps a `CryptoKey` and provides:

- `Key.create(password)` - derives a new key from a password. generates a fresh
  salt. returns both the key and a `KeyPrint` for later verification.
- `Key.recreate(password, keyPrint)` - re-derives the key from an existing salt
  and verifies against the stored hash. returns null on mismatch.
- `Key.fromJson(keyJson)` - imports a key from its JWK representation (used to
  restore from session storage).
- `seal(message)` - encrypts a string to a `Box`.
- `unseal(box)` - decrypts a `Box` to a string, or returns null on failure.

decryption errors are caught and return null. only unexpected errors (not
`TypeError` or `OperationError`) are logged, to avoid leaking information.

## encrypted storage proxy

`createEncryptedLocal` wraps the chrome local storage interface with a
transparent proxy. for keys in the `ENCRYPTED_KEYS` set, reads decrypt and
writes encrypt automatically. all other keys pass through unchanged.

on unlock, the persist layer re-hydrates encrypted data by calling
`readEncrypted` for each encrypted key. a zustand subscription watches for
keyring status transitions to `unlocked` and triggers re-hydration.

## key print

the `KeyPrint` stores:

- `hash` - SHA-256 of the raw exported key bytes (not the password)
- `salt` - the PBKDF2 salt used during derivation

both are serialized as base64 strings. the key print is stored persistently and
used during unlock to verify the password before attempting decryption. the
actual derived key is never stored persistently - only in session storage while
unlocked.
