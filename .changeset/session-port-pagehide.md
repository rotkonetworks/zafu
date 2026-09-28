---
'zafu': patch
---

Release a page's wallet session when the page is hidden and kept. A dapp page
that navigated away never sent the end message, so its port outlived the
navigation: Chromium then closed the channel for us and reported an unchecked
`runtime.lastError`, and a running block-processor stream stayed attached to a
frozen document. A page restored from the back/forward cache reconnects on
demand.

The teardown is registered only where a document exists. The service worker
bundle reaches this module too and has no `window`, so an unguarded listener
threw `ReferenceError: window is not defined` while the worker evaluated the
module - which aborted the entire worker boot, leaving no message, alarm or
connect listener installed at all.
