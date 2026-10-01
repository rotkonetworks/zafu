---
'@zafu/zirc': minor
---

`RoomConfig.plaintextBytes` lets a room pad to a size other than chat's default
1 KiB - `GROUP_ROOM_PLAINTEXT_BYTES` (4 KiB) for a group-purse or door room,
which needs more body than a chat line. `relayLimitsFor(plaintextBytes)`
computes the `createHttpRelayTransport` options (`maxEntryBase64`,
`maxEntries`, `maxBodyBytes`) a room of that size needs - pairing with
`@zafu/zid`'s new transport options in the same release. Every entry in one
room is still a single fixed size, so a window's entries stay
indistinguishable by length within that room.

`Room.syncSince(sinceEpoch, maxWindows = 288)` catches a member up from a
given epoch to now, bounded at `maxWindows`, for rooms a relay retains longer
than `sync`'s `historyWindows` default covers (see `apps/minirelay`'s new
per-scope retention). Neither this nor any other `Room` method runs on its
own: constructing or restoring a `Room` makes no network request, and nothing
in this package polls or opens a connection by itself - only an explicit
`sync`/`syncSince`/`send`/`announce` call does.

An oversized entry a transport refuses (see the paired `@zafu/zid` change) is
now reported in `RoomSync.dropped` with `kind: 'oversize'`, rather than simply
being absent from `messages`.
