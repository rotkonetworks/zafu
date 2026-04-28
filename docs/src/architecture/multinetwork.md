# multi-network architecture

zafu supports multiple blockchain networks from a single wallet. networks are
categorized by their privacy and consensus properties, and each category has
different sync and key derivation requirements.

## network categories

defined in `apps/extension/src/state/keyring/network-types.ts`:

### privacy networks

require local block scanning with dedicated wasm workers. the chain data is
encrypted and must be trial-decrypted against the user's viewing keys.

- **zcash** - orchard shielded pool. uses ZIP-32 key derivation, coin type 133.
  wasm module: `@rotko/zcash-wasm` (zafu-wasm with rayon parallel proving).
- **penumbra** - shielded dex. uses penumbra-specific derivation, coin type 6532.
  wasm module: `@rotko/penumbra-wasm`.

### ibc/cosmos chains

transparent chains using BIP44 secp256k1 with bech32 address encoding. primarily
used for deposits into and withdrawals from penumbra via ibc. only chains with
an active relay channel against penumbra are listed here.

- **noble** - bech32 prefix `noble`, denom `uusdc`
- **cosmoshub** - bech32 prefix `cosmos`, denom `uatom`

all ibc chains use the same coin type 118 and derivation path `m/44'/118'/0'/0/0`,
differing only in bech32 prefix.

### transparent networks

fully public ledgers with no client-side scanning requirement.

- **polkadot** - ss58 prefix 0, supports sr25519/ed25519/ecdsa encryption types.
  includes parachains (hydration, acala, moonbeam, astar) as sub-chain configs
  under the polkadot umbrella.
- **kusama** - ss58 prefix 2, same encryption type support as polkadot. includes
  parachains (karura, moonriver).
- **ethereum** - secp256k1, chain id 1, BIP44 coin type 60.
- **bitcoin** - BIP-84 native segwit (`bc1...`), coin type 0.

substrate networks (polkadot, kusama) support multiple encryption types per
network. the default is sr25519, but users can choose ed25519 (including
ledger-compatible SLIP-10/BIP32-Ed25519 derivation) or ecdsa (for evm-compatible
parachains like moonbeam).

## network configuration

`apps/extension/src/config/networks.ts` is the single source of truth for ui
display and feature flags:

```typescript
interface NetworkConfig {
  name: string;
  color: string;
  transparent: boolean;
  launched: boolean;
  features: { stake, swap, vote, inbox };
}
```

the `launched` flag controls which networks appear in the ui. currently launched:
zcash and penumbra. other networks are defined but gated behind `launched: false`.

`NETWORK_CONFIGS` in `network-types.ts` holds the technical config (symbol,
decimals, derivation paths, ss58 prefixes, bech32 prefixes, chain ids).

## vault system - one seed, multiple networks

the keyring vault system (described in detail in [state.md](state.md)) maps one
vault to multiple network keys. a single bip39 mnemonic stored in a vault can
derive keys for every supported network using standard derivation paths:

| network    | coin type | path                    |
|------------|-----------|-------------------------|
| penumbra   | 6532      | `m/44'/6532'/0'`        |
| zcash      | 133       | `m/44'/133'/0'/0/0`     |
| noble      | 118       | `m/44'/118'/0'/0/0`     |
| cosmoshub  | 118       | `m/44'/118'/0'/0/0`     |
| polkadot   | 354       | `m/44'/354'/0'/0'/0'`   |
| kusama     | 434       | `m/44'/434'/0'/0'/0'`   |
| ethereum   | 60        | `m/44'/60'/0'/0/0`      |
| bitcoin    | 0         | `m/84'/0'/0'/0/0`       |

zigner-zafu vaults import viewing keys (not mnemonics) from an air-gapped
signing device. these vaults declare which networks they support based on the
keys present in the import data (`fullViewingKey` for penumbra, `viewingKey` for
zcash, `polkadotSs58` for substrate, `cosmosAddresses` for ibc chains).

frost-multisig vaults store a frost dkg key package and ephemeral seed. these
currently support zcash only.

## network activation

a network is only active (apis injected, features loaded, sync running) when two
conditions are met:

1. the user has at least one derived key for that network
2. the network is in the `enabledNetworks` list

this is formalized in the `NetworkActivation` type:

```typescript
interface NetworkActivation {
  network: NetworkType;
  hasKeys: boolean;
  isEnabled: boolean;
  shouldInjectProvider: boolean;  // hasKeys AND isEnabled
  shouldLoadFeatures: boolean;    // isEnabled
}
```

this prevents leaking wallet presence to dapps for unused networks. if a user has
not enabled zcash, no zcash provider is injected and no zcash wasm is loaded.

## network workers

`apps/extension/src/state/keyring/network-worker.ts` manages dedicated web workers
for each privacy network. each worker runs in its own thread with:

- separate memory space (no cross-contamination between networks)
- its own wasm instance
- its own sync loop
- its own indexeddb store

### worker lifecycle

`spawnNetworkWorker(network)` creates a `new Worker(url, { type: 'module' })` for
the requested network. concurrent spawn calls are deduplicated - multiple callers
share the same spawn promise.

currently supported worker urls:

- zcash: `/workers/zcash-worker.js`
- penumbra: `/workers/penumbra-worker.js`

the worker posts a `ready` message once its wasm is initialized. the spawn
function polls for this and times out after 30 seconds.

`terminateNetworkWorker(network)` calls `worker.terminate()` and removes the
worker state, fully freeing the wasm memory.

### message protocol

communication uses a typed request/response protocol over `postMessage`:

```
NetworkWorkerMessage (to worker):
  type: init | derive-address | sync | stop-sync | reset-sync |
        get-balance | send-tx | shield | get-notes | decrypt-memos |
        get-history | sync-memos | frost-dkg-part1/2/3 | frost-sign-round1 |
        frost-spend-sign | frost-spend-aggregate | frost-derive-address | ...
  id: string (for correlating responses)
  network: NetworkType
  walletId?: string
  payload?: unknown

NetworkWorkerResponse (from worker):
  type: ready | address | sync-progress | balance | tx-result | error | ...
  id: string
  network: NetworkType
  payload?: unknown
  error?: string
```

`callWorker<T>()` sends a message and returns a promise that resolves when the
worker posts a response with the matching `id`. progress messages
(`sync-progress`, `send-progress`, `mempool-update`) are emitted as
`CustomEvent`s on `window` rather than resolving promises.

### zcash worker capabilities

the zcash worker handles:

- address derivation from mnemonic or ufvk
- block scanning and trial decryption (orchard pool)
- balance computation
- transaction building (fully signed or unsigned for cold signing)
- transaction completion (applying signatures from zigner and broadcasting)
- shielding transparent funds to orchard
- memo decryption
- frost dkg (3-round distributed key generation)
- frost signing (nonce generation, spend authorization, share aggregation)
- frost address derivation from group key

### offscreen proving relay

the zcash worker runs inside a web worker which cannot call chrome extension apis.
halo 2 proving requires parallel wasm (rayon thread pool) which needs an offscreen
document. the relay path is:

1. zcash worker posts `prove-request` to the network worker manager
2. manager calls `chrome.runtime.sendMessage({ type: 'ZCASH_ENSURE_OFFSCREEN' })`
   to the service worker
3. service worker creates the offscreen document if needed
4. manager sends `chrome.runtime.sendMessage({ type: 'ZCASH_BUILD', request })`
5. offscreen document runs the parallel proving and returns the result
6. manager posts `prove-response` back to the zcash worker

## network feature loading

`apps/extension/src/state/keyring/network-loader.ts` lazily loads wasm and
features only for enabled networks.

privacy networks require wasm initialization:

- penumbra: imports `@rotko/penumbra-wasm/init` and calls
  `initWasmWithParallel(numThreads)` using `navigator.hardwareConcurrency`
- zcash: imports and calls `initZcashWasm()`

transparent networks need no wasm - they are marked as loaded immediately.

`syncNetworkLoading()` is called when the user enables/disables networks or
adds/removes keys. it loads features for newly enabled networks and unloads
features for disabled ones.

## penumbra services

penumbra uses a different architecture from the network worker system. rather than
a dedicated web worker, penumbra services run inside the service worker itself
using the `Services` class from `@repo/context`.

`startWalletServices()` in `apps/extension/src/wallet-services.ts`:

1. checks if penumbra is enabled (privacy gate - no network connections unless
   user has opted in)
2. waits for the wallet to be decrypted (listens for session key or wallet
   creation)
3. fetches the grpc endpoint from storage (supports per-network endpoints, legacy
   single endpoint, or default `https://penumbra.rotko.net`)
4. queries `chainId` from the endpoint's `AppService`
5. creates a `Services` instance with wallet id, full viewing key, numeraires,
   and sync height hints
6. starts a subscription that syncs `fullSyncHeight` from indexeddb to
   `chrome.storage.local` (used by the ui to show sync progress)

the block processor runs via `ws.blockProcessor.sync()` and is stopped/restarted
on wallet switches.

## wallet switching

when the user selects a different vault via `selectKeyRing(vaultId)`:

1. the keyring updates `selectedVaultId` in storage
2. it syncs `activeWalletIndex` (penumbra) and `activeZcashIndex` (zcash) to
   point to the wallet entries linked to the selected vault
3. the service worker's storage change listener detects the `activeWalletIndex`
   change and calls `reinitializeServices()`
4. `reinitializeServices()` stops the old block processor, resets the wallet
   cache, clears `fullSyncHeight`, and starts fresh wallet services for the new
   wallet

when switching the active network via `setActiveNetwork(network)`:

1. the keyring checks if the currently selected vault supports the new network
2. if not, it searches for a compatible vault (one whose type supports the
   target network) and auto-selects it
3. for penumbra, it also syncs `activeWalletIndex`

this ensures the ui always shows a vault that is capable of operating on the
active network.

## substrate chain support

polkadot and kusama act as umbrella networks for their parachains.
`SUBSTRATE_CHAINS` in `network-types.ts` defines known chains with their
ss58 prefixes, para ids, and rpc endpoints.

the service worker also supports custom chainspecs loaded from storage. on
startup and when `customChainspecs` changes in storage, `loadCustomChainspecs()`
registers/unregisters chains with the polkadot light client via
`registerCustomChainspec()` / `unregisterCustomChainspec()`.
