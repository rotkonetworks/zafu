# chrome extension architecture

zafu is a chrome mv3 extension. the background runs as a service worker, content
scripts bridge dapps to the extension, and the ui renders in a popup, side panel,
or full-page tab.

## manifest

`apps/extension/public/manifest.json` declares:

- `manifest_version: 3`
- minimum chrome 119
- permissions: `storage`, `unlimitedStorage`, `offscreen`, `alarms`, `sidePanel`,
  `contextMenus`
- `host_permissions: <all_urls>` - needed for grpc-web requests to arbitrary
  endpoints and content script injection
- `externally_connectable` matches `https://*/*` plus localhost variants, allowing
  dapps to send messages directly via `chrome.runtime.sendMessage`
- csp allows `wasm-unsafe-eval` for penumbra and zcash wasm modules

two content scripts are declared, both injected at `document_start` on all https
pages and localhost:

| script                       | world    | purpose                              |
|------------------------------|----------|--------------------------------------|
| `injected-session.js`        | ISOLATED | relay messages between page and sw   |
| `injected-penumbra-global.js`| MAIN     | inject `PenumbraSymbol` provider     |

## service worker lifecycle

the service worker entry is `apps/extension/src/service-worker.ts`. it initializes
in a specific order designed to handle the fact that wallet data is encrypted at
rest and may not be available immediately.

### phase 1 - immediate listener registration

message listeners are registered synchronously, before any async work:

```
chrome.runtime.onMessage.addListener(contentScriptConnectListener)
chrome.runtime.onMessage.addListener(contentScriptDisconnectListener)
chrome.runtime.onMessage.addListener(contentScriptLoadListener)
chrome.runtime.onMessage.addListener(internalRevokeListener)
```

this is required because chrome mv3 service workers can start and stop at any
time. if listeners were registered inside an async init function, messages arriving
before init completes would be dropped.

### phase 2 - deferred handler and CRSessionManager

a deferred handler pattern queues rpc requests until wallet services are ready:

```typescript
let resolveHandler: (h: HandlerFn) => void;
const handlerReady = new Promise<HandlerFn>(r => { resolveHandler = r; });

const deferredHandler: HandlerFn = (request, signal, timeoutMs) =>
  handlerReady.then(h => h(request, signal, timeoutMs));

CRSessionManager.init(ZAFU, deferredHandler, validateSessionPort);
```

`CRSessionManager` (from `@penumbra-zone/transport-chrome`) manages
`chrome.runtime.Port` sessions between content scripts and the service worker.
it is initialized immediately with the deferred handler so that content scripts
can establish session ports right after the user approves a connection in the popup.
rpc requests sent over these ports will block on `handlerReady` until the real
handler resolves.

`validateSessionPort` checks whether a port's sender is either a valid internal
sender (extension pages) or an approved external sender (dapp origin previously
approved by the user).

### phase 3 - wallet services initialization

`initHandler()` starts wallet services with exponential backoff:

```typescript
void backOff(() => initHandler(), {
  startingDelay: 5_000,
  numOfAttempts: Infinity,
  maxDelay: 20_000,
}).then(handler => resolveHandler(handler));
```

`initHandler()` does the following:

1. tracks the initial `activeWalletIndex` from storage
2. calls `startWalletServices()` which waits for the wallet to be unlocked
   (encrypted wallets require the session key to decrypt)
3. gets all rpc implementations via `getRpcImpls()`
4. creates a `connectChannelAdapter` with connect-rpc routing and context values
5. returns the handler, which resolves `handlerReady` and unblocks queued rpc
   requests

the connect-rpc adapter routes protobuf service calls to their implementations.
context values are injected per-request:

- `fvkCtx` - full viewing key getter
- `servicesCtx` - wallet services (indexeddb, block processor, querier)
- `walletIdCtx` - wallet id getter
- `custodyClientCtx` / `stakeClientCtx` - internal rpc clients
- `authorizeCtx` - only injected for custody service paths

### phase 4 - storage change listeners

the service worker listens for `chrome.storage.local` changes to react to:

- **wallet switching** - when `activeWalletIndex` changes, `reinitializeServices()`
  tears down the old block processor, resets the wallet cache, clears
  `fullSyncHeight`, and starts fresh services for the new wallet
- **first vault creation** - when `vaults` goes from empty to non-empty, services
  are initialized for the first time
- **penumbra network enabled** - when penumbra appears in `enabledNetworks`,
  services are initialized
- **custom chainspecs** - polkadot custom chainspecs are reloaded

### background sync

a chrome alarm fires every 30 minutes to trigger background block sync. this is
gated by a user privacy setting (`enableBackgroundSync`). when disabled, no
network requests are made in the background.

### offscreen document

zcash halo 2 proving requires parallel wasm threads (rayon). chrome mv3 does not
allow web workers inside service workers, so proving runs in an offscreen document.
the service worker listens for `ZCASH_ENSURE_OFFSCREEN` messages and calls
`chrome.offscreen.createDocument()` as needed.

## content scripts

### ISOLATED world - injected-session.ts

runs in the isolated content script world. has access to `chrome.runtime` apis
but not the page's js context.

responsibilities:

- listens for `ZafuMessageEvent` from the page (MAIN world). when it receives a
  `ZafuConnection` message (connect/disconnect/load), it forwards it to the
  service worker via `chrome.runtime.sendMessage` and relays the response back
  to the page
- listens for `ZafuControl` messages from the service worker. on `Init`, it calls
  `CRSessionClient.init(extensionId)` which creates a `chrome.runtime.Port` and
  sends the `MessagePort` end to the page. on `End`, it tears down the session
  and notifies the page

this script bridges the two worlds: the page cannot talk to `chrome.runtime`
directly, and the service worker cannot post messages to the page directly.

### MAIN world - injected-penumbra-global.ts

runs in the page's js context. has no access to chrome extension apis.

creates the `window[Symbol.for('penumbra')]` global that dapps use to discover
and connect to penumbra wallet providers. the global is a record keyed by
extension origin (`chrome-extension://<id>`), with each value being a frozen
`PenumbraProvider` object:

```typescript
{
  connect: () => Promise<MessagePort>,
  disconnect: () => Promise<void>,
  isConnected: () => boolean,
  state: () => PenumbraState,
  manifest: string,       // URL to extension manifest.json
  addEventListener: ...,
  removeEventListener: ...,
}
```

the `ZafuInjection` class manages connection state transitions:

- `Disconnected` - initial state
- `Pending` - connect request sent, waiting for approval
- `Connected` - session port received from ISOLATED world

on construction, the script sends a `ZafuConnection.Load` event to announce its
presence. if the service worker recognizes the origin as previously approved, it
sends back `ZafuControl.Preconnect` and the state transitions directly to
`Connected`.

the global is frozen and defined as non-writable to discourage tampering, though
as noted in the source comments, any script running on the page can potentially
interfere.

## dapp connection flow

1. dapp calls `window[PenumbraSymbol][extensionOrigin].connect()`
2. MAIN world script sends `ZafuConnection.Connect` via `window.postMessage`
3. ISOLATED world script receives it and forwards to service worker via
   `chrome.runtime.sendMessage`
4. service worker's `contentScriptConnectListener` checks if the origin is
   approved. if not, it opens the approval popup
5. on approval, service worker sends `ZafuControl.Init` back to the ISOLATED
   world script
6. ISOLATED world script calls `CRSessionClient.init()` which opens a
   `chrome.runtime.Port` to `CRSessionManager` in the service worker
7. the `MessagePort` end is posted to the MAIN world via `window.postMessage`
8. dapp receives the `MessagePort` and uses it for protobuf-over-postmessage rpc

## external messages

the extension also handles `chrome.runtime.onMessageExternal` for:

- **sign requests** - approved origins can request ed25519 identity signatures
- **easter egg messages** - external message handler for misc interactions

## side panel and context menu

clicking the extension icon opens the side panel by default
(`openPanelOnActionClick: true`). a context menu entry allows opening the popup
in a standalone window.

on first install, the options page (onboarding) opens automatically.
