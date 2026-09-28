---
'zafu': patch
---

Approval popups no longer fail to open when their anchor lands off-screen.

`openApprovalPopup` anchored every approval window (login, connect, sign, passkey
consent) to `lastFocused.left + width - POPUP_WINDOW_WIDTH`, computed from the
browser **window's** geometry. Chrome rejects a `windows.create` whose bounds are
less than half inside the visible screen, so a window dragged past the screen edge,
display scaling, a virtual display, or a window wider than the reported screen made
the create throw. The popup never appeared, the dapp got no response for its
request, and it fell back to the platform authenticator - the failure was silent
because the rejection happened inside the service worker before any surface
existed to show it. The anchor is now best-effort: on a bounds rejection the window
is re-created with the canonical 420x760 sizing and Chrome's own on-screen
placement, and any other error still propagates.
