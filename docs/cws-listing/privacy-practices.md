# Privacy practices — zafu wallet BETA

Paste-ready content for the CWS "Privacy practices" tab.

---

## Single purpose

```
zafu is a self-custodial privacy wallet that lets users send, receive, sign, and verify transactions for Zcash and Penumbra entirely from the browser. All cryptographic operations (key derivation, trial decryption, merkle witness maintenance, spend proving) run client-side; no viewing key or spending key ever leaves the user's device.
```

---

## Permission justifications

### `storage`
```
Persists the encrypted wallet vault (mnemonic + derived keys), the locally-cached Zcash note set with per-note witnesses, the Penumbra view state, wallet preferences, and session metadata. All persisted data is scoped to the extension's origin and never transmitted.
```

### `unlimitedStorage`
```
Zcash note witness state and Penumbra view state grow with chain history (hundreds of MB for active users). The default 5 MB storage quota is not sufficient for a light-client that verifies the chain end-to-end; unlimitedStorage is required to keep proofs and witnesses accessible offline without relying on a server.
```

### `offscreen`
```
Manifest V3 service workers cannot hold WebAssembly instances across events. The wallet's WASM provers (Zcash orchard, Penumbra halo2) run in an offscreen document which keeps the prover alive during the 5–15 seconds a shielded spend proof takes to generate. Without `offscreen`, proving would have to restart on every network event and would not be feasible in MV3.
```

### `alarms`
```
Schedules periodic background sync of Zcash compact blocks and Penumbra view state while the extension is installed, so balances are current when the user opens the popup. Uses the Chrome alarms API instead of setInterval because MV3 service workers are killed between events.
```

### `sidePanel`
```
Enables the wallet UI to open in Chrome's side panel in addition to the popup, so users can keep the wallet visible alongside a dApp they are signing transactions for. Required to register `sidePanel.setOptions` and toggle panel visibility.
```

### `contextMenus`
```
Adds a single right-click action on selected text: "Send ZEC/Penumbra to this address" which opens the send flow pre-filled with the selected address. Does not inject any UI into the page itself.
```

---

## Host permission justifications

### `host_permissions: ["<all_urls>"]`
```
zafu implements the Penumbra wallet provider protocol and an ed25519 identity-signing API that any web application can request. By design, the extension must be able to respond to `postMessage` calls from any origin the user visits (the same way MetaMask, Phantom, and other web wallets work). The extension never reads page content; the content scripts only listen for connection-request messages originating from the page's own JavaScript.

No network requests are made to arbitrary URLs — the extension only talks to the Zcash light-server (configurable, defaults to `https://zidecar.rotko.net`) and the Penumbra grpc-web endpoint.
```

### `content_scripts` (ISOLATED + MAIN world)
```
Two lightweight scripts:

• `injected-session.js` (ISOLATED world): relays messages between the page and the extension's service worker. Read-only relay — does not touch DOM or cookies.

• `injected-penumbra-global.js` (MAIN world): exposes a minimal `window[Symbol.for('penumbra')]` provider object so dApps can detect that a Penumbra wallet is installed and request a connection. This is the standard pattern used by every existing Penumbra wallet (Prax, etc.). The global itself is frozen and only exposes `connect`, `disconnect`, `isConnected`, `state`, and event listeners.
```

### `externally_connectable: { matches: ["<all_urls>"] }`
```
Same as host_permissions — the extension listens for connection requests from dApps across any origin. The extension validates the origin on every message and only shows a connection approval prompt for explicitly user-initiated requests.
```

---

## Remote code

```
No remote code execution. All JavaScript and WebAssembly in the bundle is shipped in the package. The extension makes network requests only for chain data (block headers, compact blocks, note commitment proofs) which is treated as untrusted byte data and cryptographically verified before use.
```

---

## Data use (CWS data disclosures)

Mark each of the CWS data use categories as follows:

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information (PII) | **No** | — |
| Health information | **No** | — |
| Financial & payment info | **No** | The extension manages the user's own wallet keys locally; no payment info is collected by us |
| Authentication info | **Yes, but stored locally only** | Mnemonic seed / passkey enters the user's own encrypted vault in local storage. Never transmitted. |
| Personal communications | **No** | — |
| Location | **No** | — |
| Web history | **No** | — |
| User activity | **No** | No analytics. No telemetry. |
| Website content | **No** | — |

### Three required certifications (check all three)

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Privacy policy URL

**Required.** Host `privacy-policy.md` (rendered as HTML or plain) at a
stable URL. Suggested: `https://zafu.rotko.net/privacy`.

Until that URL is live, a shorter-term host:
`https://github.com/rotkonetworks/zafu/blob/main/docs/cws-listing/privacy-policy.md`
(raw markdown rendered by GitHub is acceptable for CWS).
