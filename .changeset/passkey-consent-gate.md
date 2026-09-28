---
'zafu': patch
---

Passkey requests now work end to end and cost one consent per site, never a
prior connection.

- `passkey-intercept` (MAIN world) no longer calls `chrome.runtime.sendMessage`,
  which in a page carries no extension id and throws on every call - registration
  and sign-in fell back to the platform authenticator silently. It now relays
  over `window.postMessage` to a new ISOLATED `passkey-bridge`, which forwards to
  the service worker exactly like `keplr-bridge`. Both worlds are declared per
  manifest (the beta manifest was also missing the intercept entry).
- `zafu_passkey_create` no longer requires a `connect` grant: the approval popup
  is the gate, so a site that never connected can still register instead of
  getting a silent `not connected`. Approving mints the site-bound P-256
  credential in the worker (the popup never touches seed material) and grants
  that origin the narrow `passkey` capability - never `connect`, so approving a
  passkey does not hand the site your address book.
- `zafu_passkey_get` accepts `passkey` as well as the existing `connect` grant, so
  the site signs in without a second popup, and a brand-new origin with neither
  grant gets no assertion.
