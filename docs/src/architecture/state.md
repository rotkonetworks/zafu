# state management

zafu uses zustand with immer for immutable state updates. the store is split into
slices, each managing a specific domain. sensitive data (wallets, contacts,
messages) is encrypted at rest in `chrome.storage.local` and decrypted on-demand
using a session key derived from the user's password.

## store structure

the store is defined in `apps/extension/src/state/index.ts`. it combines all
slices into a single `AllSlices` interface:

```typescript
export const useStore = create<AllSlices>()(
  customPersist(initializeStore(sessionExtStorage, localExtStorage)),
);
```

the middleware stack is: `customPersist` -> `immer` -> slice creators.

### slices

| slice              | purpose                                            |
|--------------------|----------------------------------------------------|
| `wallets`          | penumbra and zcash wallet records, active indices   |
| `password`         | password validation during onboarding               |
| `seedPhrase`       | seed phrase generation and validation flow           |
| `network`          | grpc endpoint, chain id, sync height                |
| `numeraires`       | selected numeraire assets for value display          |
| `txApproval`       | pending transaction approval state                  |
| `originApproval`   | pending dapp origin approval state                  |
| `connectedSites`   | known sites and their approval status               |
| `defaultFrontend`  | default frontend url for dapp links                 |
| `zigner`           | zigner air-gap device settings                      |
| `tradingMode`      | trading mode toggle                                 |
| `zignerSigning`    | active zigner signing session state                 |
| `privacy`          | user privacy settings (background sync, etc.)       |
| `networks`         | network endpoint configuration                     |
| `keyRing`          | vault management, lock/unlock, key derivation       |
| `ibcWithdraw`      | ibc withdrawal flow state                           |
| `penumbraSend`     | penumbra send flow state                            |
| `contacts`         | encrypted contact book                              |
| `messages`         | encrypted message history                           |
| `recentAddresses`  | recently used addresses (encrypted)                 |
| `signApproval`     | pending sign request approval                       |
| `frostSession`     | frost multisig dkg/signing session state            |
| `inbox`            | encrypted inbox for memo-capable chains             |

each slice creator receives the storage backends it needs. slices that persist
data get `local` (chrome.storage.local) and/or `session` (chrome.storage.session).
ephemeral slices (like `seedPhrase`, `txApproval`) receive no storage and reset
when the popup closes.

### slice creator pattern

every slice follows the same signature:

```typescript
export const createExampleSlice = (
  local: ExtensionStorage<LocalStorageState>,
): SliceCreator<ExampleSlice> => (set, get) => ({
  // state
  someValue: defaultValue,
  // actions
  setSomeValue: async (v) => {
    await local.set('someKey', v);
    set(state => { state.example.someValue = v; });
  },
});
```

`SliceCreator<T>` is typed as `StateCreator<AllSlices, [['zustand/immer', never]], [], T>`,
which gives every slice access to the full store via `get()` and immer-powered
mutations via `set()`.

## encrypted storage

`apps/extension/src/state/encrypted-storage.ts` provides transparent encryption
for sensitive storage keys.

### encrypted keys

the following storage keys are encrypted at rest:

- `penumbraWallets` - penumbra wallet records containing full viewing keys
- `zcashWallets` - zcash wallet records containing orchard full viewing keys
- `contacts` - user contact book
- `recentAddresses` - recently used addresses
- `dismissedContactSuggestions` - dismissed suggestions
- `messages` - message history

`knownSites` (origin approval records) is explicitly not encrypted because it
contains no private data (just origin, choice, date) and needs to be readable by
the origin storage package which lacks access to the session key.

### encryption mechanism

data is stored as `{ encrypted: BoxJson }` where `BoxJson` is an
`@repo/encryption/box` sealed box. the encryption key is derived from the user's
password via `@repo/encryption/key`.

the key lifecycle:

1. on password creation, `Key.create(password)` generates a key and a `KeyPrint`
   (password verification hash). the key is serialized to json and stored in
   `chrome.storage.session` (memory-only, cleared when browser closes). the
   keyprint is stored in `chrome.storage.local` (persistent).
2. on unlock, `Key.recreate(password, keyPrint)` re-derives the key from the
   password and verifies it against the keyprint. if correct, the key json is
   stored in session storage.
3. on lock, the session key is removed. encrypted data becomes unreadable until
   the next unlock.

### encrypted local proxy

`createEncryptedLocal()` wraps the local storage backend with a proxy that
automatically encrypts/decrypts values for keys in the `ENCRYPTED_KEYS` set.
callers use normal `get()`/`set()` and encryption is transparent:

```typescript
const local = createEncryptedLocal(rawLocal, session);
// local.set('penumbraWallets', wallets) -> encrypts and stores
// local.get('penumbraWallets') -> decrypts and returns
// local.set('grpcEndpoint', url) -> stores plaintext (not in ENCRYPTED_KEYS)
```

this proxy is passed to slice creators that handle sensitive data.

### reading encrypted values

`readEncrypted<T>()` reads a value from local storage, checks if it is an
`EncryptedWrapper`, retrieves the session key, decrypts, and parses the json
result. returns `null` if the value is missing, not encrypted, or the wallet is
locked.

## customPersist middleware

`apps/extension/src/state/persist.ts` implements a custom persistence middleware
that replaces zustand's built-in `persist`. it handles the two-phase hydration
required by encrypted storage.

### phase 1 - plaintext hydration

on startup, non-encrypted values are loaded immediately from
`chrome.storage.local`:

- `activeZcashIndex`
- `activeWalletIndex`
- `grpcEndpoint`
- `frontendUrl`
- `numeraires`
- `zignerCameraEnabled`
- `privacySettings`

these are set into the store via `produce()` (immer).

### phase 2 - encrypted hydration

`hydrateEncryptedData()` loads encrypted values that require the session key:

- `penumbraWallets` (via `readEncrypted`)
- `zcashWallets` (via `readEncrypted`)
- `contacts` (via `readEncrypted`)
- `recentAddresses` (via `readEncrypted`)
- `messages` (via `readEncrypted`)
- `knownSites` (plaintext, loaded directly)

this function runs:

1. immediately on startup (succeeds if already unlocked or auto-unlocked)
2. when keyring status transitions to `unlocked` (via store subscription)

the subscription watches for `status === 'unlocked' && prevStatus !== 'unlocked'`
to re-hydrate after the user enters their password.

### storage change listener

the middleware subscribes to `localExtStorage.addListener()` to sync storage
changes back into the zustand store. this handles changes from other extension
contexts (service worker, other tabs). monitored keys include:

- encrypted data keys - triggers `hydrateEncryptedData()`
- `knownSites` - hydrated directly from change event
- `fullSyncHeight`, `grpcEndpoint`, `frontendUrl`, `numeraires`, `params`,
  `zignerCameraEnabled`, `activeZcashIndex`, `activeWalletIndex`,
  `enabledNetworks`, `privacySettings` - each synced individually
- `vaults` or `selectedVaultId` - triggers `keyRing.init()` to rebuild vault list

## keyring vault system

the keyring (`apps/extension/src/state/keyring/index.ts`) manages vaults - encrypted
containers that hold seed phrases, zigner device data, or frost multisig key
packages.

### keyring status

the keyring state machine has four states:

- `not-loaded` - initial state before `init()` runs
- `empty` - no password has been set (no `passwordKeyPrint` in storage)
- `locked` - password exists but session key is not available
- `unlocked` - session key is available, vaults can be decrypted

### vault types

| type              | contents                                    |
|-------------------|---------------------------------------------|
| `mnemonic`        | bip39 seed phrase, can derive for all networks |
| `zigner-zafu`     | viewing keys from zigner air-gap device     |
| `frost-multisig`  | frost dkg key package + ephemeral seed      |
| `ledger`          | hardware wallet reference (planned)         |
| `trezor`          | hardware wallet reference (planned)         |
| `keystone`        | hardware wallet reference (planned)         |

each vault is stored as an `EncryptedVault`:

```typescript
interface EncryptedVault {
  id: string;
  type: KeyType;
  name: string;
  createdAt: number;
  encryptedData: string;  // sealed box containing mnemonic or metadata
  salt: string;
  insensitive: Record<string, unknown>;  // unencrypted metadata
}
```

the `insensitive` field stores data that can be read without decryption - things
like zid public keys, device ids, account indices, and supported networks. this
allows the ui to display vault names and types without requiring unlock.

### vault operations

the keyring code is split into three layers following a "your server as a
function" pattern:

- **vault-ops.ts** - pure domain functions. no i/o, no crypto, no storage. takes
  data, returns data. every function is independently testable.
- **crypto-ops.ts** - async crypto helpers. each function does one thing. no
  storage writes, no state updates.
- **wallet-entries.ts** - storage effects. creates penumbra/zcash wallet records
  linked to vaults, handles cleanup on deletion.

### key operations

- `newMnemonicKey(mnemonic, name)` - encrypts the mnemonic, builds a vault, stores
  it, creates a linked penumbra wallet entry, and stores the zid public key in
  unencrypted metadata
- `newZignerZafuKey(data, name)` - encrypts zigner viewing key data, builds a
  vault, creates linked wallet entries for each supported network
- `newFrostMultisigKey(params)` - encrypts the frost key package and ephemeral
  seed, builds a vault, creates a linked zcash wallet entry
- `selectKeyRing(vaultId)` - sets the selected vault, syncs the active penumbra
  and zcash wallet indices to match
- `deleteKeyRing(vaultId)` - removes the vault, removes linked wallet entries,
  cleans up zcash indexeddb data. if it was the last vault, nukes all wallet data
- `getMnemonic(vaultId)` - decrypts and returns the mnemonic for a mnemonic vault
- `lock()` / `unlock(password)` - manages the session key

### init flow

`keyRing.init()` loads vault data from storage and determines the initial status:

1. reads `passwordKeyPrint` and `vaults` from local storage
2. reads `selectedVaultId` and `enabledNetworks`
3. if no keyprint exists, status is `empty`
4. if a session key exists, status is `unlocked`
5. if all vaults are airgap-only (zigner watch-only), auto-unlocks with an empty
   password (no secrets to protect - only viewing keys)
6. otherwise, status is `locked`

the init also runs a migration check for orphaned frost multisig zcash wallets
that may lack a parent vault record.
