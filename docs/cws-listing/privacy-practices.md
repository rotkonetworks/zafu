# Privacy practices — zafu

Paste-ready content for the Chrome Web Store "Privacy practices" tab. Checked
against the code (manifest, `service-worker.ts`, `offscreen-document.ts`,
`buy/capture/run.ts`, `net/egress-policy.ts`) for 29.4.0.

## Single purpose

```
zafu is a self-custodial privacy wallet for Zcash and Penumbra: send, receive, swap and sign shielded transactions from the browser, including encrypted memos and messages between the people paying each other. Keys are created and kept on the user's device; decryption and proving run locally, and no spending or viewing key leaves the device.
```

## Permission justifications

### storage

```
Persists the encrypted wallet vault (seed phrase and derived keys), the locally kept Zcash notes with their witnesses, the Penumbra view state, contacts and messages, and wallet preferences. All of it stays in the extension's own storage on the device.
```

### unlimitedStorage

```
The wallet keeps Zcash notes with their merkle witnesses, the Penumbra view database and the shielded transaction history on the device, so balances and proofs work without handing a viewing key to a server. This state grows with chain history and passes Chrome's default storage quota for active wallets; unlimitedStorage keeps it from being evicted.
```

### offscreen

```
Used for one reason, WORKERS: Zcash Halo 2 proofs are built with a pool of web workers (rayon), which an MV3 service worker cannot start. The offscreen document hosts that worker pool while a shielded transaction is proved, then the result goes back to the wallet. It shows no UI and loads only files from the extension package.
```

### alarms

```
Three alarms: "blockSync" every 30 minutes keeps Zcash and Penumbra balances current; "idleCheck" every minute locks the wallet after the user's chosen idle time; "ibcTransferPoll" every minute follows a pending IBC transfer to arrival or timeout. Alarms are used because MV3 service workers stop between events, so timers would not survive.
```

### sidePanel

```
Enables the wallet UI to open in Chrome's side panel in addition to the popup, so users can keep the wallet visible alongside a site they are signing transactions for.
```

### contextMenus

```
Adds one item to the right-click menu of zafu's own toolbar icon: "Open Zafu in Popup Window", which opens the wallet in a separate window. It adds nothing to web pages or to the page's context menu.
```

### webRequest (optional)

```
Optional, used only by "buy ZEC with cash" (Peer). When the user taps to confirm a cash payment, zafu opens their payment app (Revolut, Wise, Zelle, Monzo, Venmo, PayPal or Cash App) in a tab and uses webRequest to see that tab's requests to that app's own hosts, so it can find the one request that lists the payment and send proof of it to Peer's verifier. The listener is filtered to the payment app's hosts and to the single tab zafu opened; no other site or tab is observed. Nothing is stored: the data lives in memory for the seconds the check takes, then the tab is closed. The permission is requested only at that tap and given back when the check ends, unless the user chooses to keep it.
```

### scripting (optional)

```
Optional, used only by "buy ZEC with cash" (Peer). For payment apps that need it, zafu uses scripting.executeScript to repeat the payment-list request inside the payment app tab it opened itself, so the request carries the app's own session and returns the payment for Peer to verify. It runs only in that one tab zafu opened, only on the payment app's own pages, and only during the check the user started with a tap. No script is injected into any other page or tab. Nothing is stored: the result is used in memory, then the tab is closed. The permission is requested only at that tap and given back when the check ends, unless the user chooses to keep it.
```

## Host permission justification (`<all_urls>` and content scripts)

```
Content scripts on https pages, each limited to one job: (1) the Penumbra wallet provider and a Keplr-compatible API, which answer only connection and signing requests from the page's own JavaScript, after the user approves; (2) an optional passkey authenticator that offers zafu when a site calls WebAuthn, after the user confirms; (3) a link handler that opens zcash: and zafu: payment links the user clicks. None of them reads or sends page content. <all_urls> host access is needed because the user chooses the servers zafu talks to - Zcash light servers, Penumbra nodes, message relays - and can enter any address. zafu asks before contacting a server for the first time, and lists every server it talks to, and why, in its settings.
```

Default servers (all changeable in settings; the full list, with the reason for
each, is `net/egress-policy.ts`):

- Zcash light server: `zcash.rotko.net`
- Penumbra node: `penumbra.rotko.net`
- Message relays: `relay.zafu.pro`
- Swaps: `1click.chaindefuser.com` (NEAR Intents), THORChain nodes and Midgard, `api.skip.build` (IBC routes)
- Buying ZEC: Peer, the Base network RPC, the payment app the user picks
- Optional, off until turned on: contact discovery, zcash.me, governance voting, penumbra registry updates, nym, the pro license server (`license.zafu.pro`)

## Remote code

**No.** Every JS and Wasm file is in the package. The only `eval` /
`new Function` strings are library helpers (a `globalThis` fallback and
wasm-bindgen glue), and the extension CSP (`script-src 'self'
'wasm-unsafe-eval'`, no `'unsafe-eval'`) would block a string eval anyway.
Zigner modules zafu relays to the phone are run there, never in zafu.

## Data usage

Tick:

- **Financial and payment information** — transactions go to the network
  through the chosen node; swaps send an address and amount to the swap
  service; "buy with cash" sends proof of one payment to Peer's verifier.
- **Personal communications** — chat messages leave the device through a
  relay, encrypted end to end.

Leave unticked: personally identifiable information, health, authentication
information (passwords and passkeys are derived on the device, never sent),
location, web history, user activity, website content.

Certify all three disclosures.

## Privacy policy URL

```
https://github.com/rotkonetworks/zafu/blob/main/docs/cws-listing/privacy-policy.md
```
