---
'@zafu/zid': minor
---

`createHttpRelayTransport` takes `maxEntryBase64`, `maxEntries` and
`maxBodyBytes` as options now, defaulting to the same ceilings it always used
(`MAX_RELAY_ENTRY_BASE64`, `MAX_RELAY_ENTRIES`, `MAX_RELAY_BODY_BYTES`) - private
contact discovery's own callers are unaffected.

The default ceiling (1024 base64 characters per entry) was sized for
discovery's 64-byte presence blobs and silently discarded anything bigger: a
`@zafu/zirc` room's sealed record is already 1053 bytes (1404 base64
characters) at chat's default size, so every room entry was refused before the
room ever saw it, with no signal that anything had been dropped. A caller with
a bigger fixed record size (a room) now passes its own `maxEntryBase64`.

`getBucket`'s result also now reports what it refused: the returned array
carries a `droppedOversize: { index, base64Length }[]` (via
`GetBucketResult`), so an oversized entry is a counted refusal instead of a
silent gap. Nothing about the shape or values of the entries array itself
changed.
