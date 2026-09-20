# chrome extension architecture

zafu is a chrome mv3 extension. the background runs as a service worker, content
scripts bridge dapps to the extension, and the ui renders in a popup, side panel,
or full-page tab.

## manifest

`apps/extension/public/manifest.json` declares:

- `manifest_version: 3`
- minimum chrome 119
- permissions: `storage`, `unlimitedStorage`, `offscreen`, `alarms`, `sidePanel`,
  `contextMenus`, `proxy` (`proxy` backs the transport-privacy proxy feature)
- `host_permissions: <all_urls>` - needed for grpc-web requests to arbitrary
  endpoints and content script injection
- `externally_connectable` matches `https://*/*` plus localhost variants, allowing
  dapps to send messages directly via `chrome.runtime.sendMessage`
- csp allows `wasm-unsafe-eval` for penumbra and zcash wasm modules

five content scripts are declared, all injected at `document_start` on all https
pages and localhost:

| script                        | world    | purpose                                     |
| ----------------------------- | -------- | ------------------------------------------- |
| `injected-session.js`         | ISOLATED | relay penumbra messages between page and sw |
| `keplr-bridge.js`             | ISOLATED | relay keplr messages between page and sw    |
| `injected-penumbra-global.js` | MAIN     | inject the `PenumbraSymbol` provider        |
| `injected-keplr.js`           | MAIN     | inject a `window.keplr` provider for cosmos |
| `passkey-intercept.js`        | MAIN     | wrap `navigator.credentials` (webauthn)     |

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
const handlerReady = new Promise<HandlerFn>(r => {
  resolveHandler = r;
});

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

### alarms and background sync

the service worker registers three `chrome.alarms`:

- `blockSync` - fires every 30 minutes to trigger background block sync. only
  transparent networks honor the `enableBackgroundSync` privacy setting; shielded
  (penumbra, zcash) and light-client (polkadot) networks always sync, since trial
  decryption and p2p never leak addresses and those networks expose no toggle
- `idleCheck` - fires every minute to drive the idle auto-lock
- `ibcTransferPoll` - fires every minute to poll pending ibc transfers for arrival
  or timeout

### idle auto-lock

the worker tracks a `lastActivityMs` timestamp. only messages that originate from
the ui (popup, side panel, page) or from dapp interactions (external messages)
reset the timer - background service messages (sync, alarms) deliberately do not.
`idleCheck` locks the keyring once the idle window elapses.

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

the extension handles `chrome.runtime.onMessageExternal` with three listeners:

- `signRequestListener` - approved origins can request ed25519 identity signatures
- `externalMessageListener` - the general `zafu_*` protocol (contact picking, frost
  ceremonies, capability grants, zcash send, etc.)
- `encryptionMessageListener` - the external sealed-box encrypt/decrypt api and zid
  public key lookup

popup results are sent back over the internal `chrome.runtime.sendMessage`
(`onMessage`) channel, but a small bridge routes a known set of internal result
types (`zafu_pick_contacts_result`, `zafu_frost_result`, `zafu_capability_result`,
`zafu_zcash_send_result`, `zafu_encryption_approval_result`) into the external
listeners that own their handlers.

a separate `keplr` listener on `chrome.runtime.onMessage` serves the injected
`window.keplr` provider for cosmos dapps.

## routing and error handling

the ui bundles have three entry points in `apps/extension/src/entry/`:

- `popup-root.tsx` - renders `popup.html` and `sidepanel.html` (both use the same
  bundle and popup router)
- `page-root.tsx` - renders the full-page `page.html` (options / onboarding)
- `offscreen-handler.ts` - the offscreen document that runs parallel zcash proving

both routers are `createHashRouter` instances (react-router-dom 7). because every
route is `lazy()`-loaded, a chrome auto-update while a popup or the long-lived side
panel is open can 404 the old chunk urls and throw a `ChunkLoadError` on `import()`.
`src/components/error-boundary.tsx` handles this:

- `RouteErrorScreen` is wired as each router's `ErrorBoundary` - it catches loader,
  action, and render throws (including lazy-chunk failures) inside the router
- `AppErrorBoundary` is a class boundary wrapping `RouterProvider` in each entry,
  for throws above the router that a route handler can never see

a stale-chunk error triggers a single guarded `window.location.reload()`
(a `sessionStorage` guard prevents a reload loop); the fresh load pulls the new
chunks. approval-popup paths offer a "close" action instead of "go home" so a
pending dapp request is not silently abandoned.

## side panel and context menu

clicking the extension icon opens the side panel by default
(`openPanelOnActionClick: true`). a context menu entry allows opening the popup
in a standalone window.

on first install, the options page (onboarding) opens automatically.
