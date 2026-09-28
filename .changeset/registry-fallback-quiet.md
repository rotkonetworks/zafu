---
'@repo/context': patch
---

Fall back to the bundled registry when the remote one cannot be fetched. A
blocked, offline or rate-limited registry host used to surface as `Failed to
fetch` and abort pre-population of the asset list; the fallback is now shared by
the startup path and the extension pages instead of living in the startup path
only.
