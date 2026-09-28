---
'zafu': patch
---

Recover cleanly when the extension is reloaded or auto-updated under an open
page. The side panel and popups no longer storm the console with
"Extension context invalidated" transport errors; they show one reload notice
and quiet the transport's dev-only noise. The reload notice is now shared by
content scripts and the extension's own pages.
