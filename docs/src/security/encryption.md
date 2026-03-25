# encryption at rest

zafu encrypts sensitive wallet data in chrome.storage.local using AES-256-GCM
with a key derived from the user's password via PBKDF2.

## what is encrypted

the following storage keys are encrypted at rest:

- `penumbraWallets` - penumbra full viewing keys and custody data
- `zcashWallets` - zcash orchard full viewing keys and addresses
- `contacts` - user contact entries
- `recentAddresses` - recently used addresses
- `dismissedContactSuggestions` - dismissed contact suggestion records
- `messages` - zcash memo messages

viewing keys (FVK) reveal full transaction history. no viewing key data is
stored in plaintext - ever.

the following are not encrypted:

- `knownSites` - origin approval records (origin, choice, date). these contain
  no private data and are read by the origin storage package which does not have
  access to the session key.
- `grpcEndpoint`, `frontendUrl`, `numeraires`, `activeWalletIndex`,
  `activeZcashIndex` - non-sensitive configuration values.

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

all cryptographic operations use the Web Crypto API (`crypto.subtle`). no
third-party cryptography libraries are involved.

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
