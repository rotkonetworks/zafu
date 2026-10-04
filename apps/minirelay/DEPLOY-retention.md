# Deploying per-scope retention (not done by this change)

This change teaches `minirelay` to keep one scope's rows longer than the
default (`MINIRELAY_SCOPE_RETENTION`, see the README's configuration table and
`src/config.rs`). Nothing here touches a running deployment - this is the note
for whoever does.

## The config change needed in production

Add one environment variable to the relay process behind `zcash.rotko.net` /
`bucket` (and `zrelay.rotko.net`, if it runs a separate instance):

```
MINIRELAY_SCOPE_RETENTION=zafu-group-v1=90000
```

`zafu-group-v1` is the exact `appScope` a `@zafu/zirc` group-purse room uses
(`packages/zirc/src/room/room.ts`'s `ZAFU_GROUP_APP_SCOPE` constant - the config
string and the client constant are meant to be copy-pasted from one source, not
kept in sync by hand). `90000` seconds is 25 hours: one hour past the canvas's
"a day" promise, so a proposal sealed at 14:20 and opened again at 19:05 the
next day is still on the board, with margin.

**Open item carried over from the design doc (`design-groups-on-zirc.md`,
section 0):** this checkout does not show what actually serves `/bucket` on
`zcash.rotko.net` today - a `minirelay` process behind haproxy, or a route
`zidecar` answers itself. Confirm which it is before touching production
config:

- if it is `minirelay`, set the environment variable above and restart the
  process (`MINIRELAY_SCOPE_RETENTION` is read once, at `Config::from_env()`
  startup - there is no hot reload);
- if `/bucket` is served by something else, this PR's config format does not
  apply there and that service needs its own equivalent change, or `minirelay`
  needs to be put in front of it for this scope.

No code in this PR is deployed by writing this file. Do not restart the
production relay as part of landing this change.

**The binary must be rebuilt from this commit (or later), not just restarted
with the new env var.** This PR also raises the server's own per-entry size
ceiling (`BLOB_MAX_BYTES` in `src/server.rs`, 4096 -> 8192 bytes) - a sealed
4 KiB group room record is 4125 bytes, over the old ceiling. On the currently
deployed binary, setting `MINIRELAY_SCOPE_RETENTION` alone gets a group's rows
kept 25h but every `PUT` of a group-sized record still fails with HTTP 400
(a loud rejection at write time, not a silent drop - recognisable in the
relay's access logs as 400s on `/bucket` from zafu clients, not as a quiet
absence of messages). Both changes - the retention env var and the rebuilt
binary - are needed together before group rooms work end to end against this
relay.

## Storage-growth estimate

Per-scope retention changes how long a scope's rows survive the 60s sweep, not
the write rate. For `zafu-group-v1` specifically:

- a group's board write rate is small: a handful of members, each publishing a
  few signed records (chat, a seal, a share) per active 5-minute window - not
  the `publishers × 64` padded batch contact discovery writes every epoch
  whether anyone is talking or not.
- holding rows 25h instead of the default 1h means roughly 25x as many
  **swept-but-not-yet-expired** rows for this one scope, for the same write
  rate. Worked out in absolute terms: even a very active group (10 members, 20
  records/window, 4 KiB plaintext -> ~4.1 KB sealed blob each) writing in every
  window for the full 25h window is `10 * 20 * (25*60/5) = 30,000` rows, about
  120 MB. A realistic group (seconds of activity around a proposal, long idle
  stretches otherwise) is a small fraction of that - low single-digit megabytes
  per active group is the expected case.
- this is additive to, not a multiplier on, contact discovery's existing
  cost (README's "Scaling" section): discovery's scope is unaffected by this
  change and keeps its own 1h retention.
- the hard backstop is `MINIRELAY_MAX_SCOPE_RETENTION_SECONDS` (default 48h,
  also unset in production today): whatever `MINIRELAY_SCOPE_RETENTION` asks
  for a given scope, the relay will not keep it past that ceiling. If a future
  deployment wants `zafu-group-v1` kept longer than 48h, raise the cap
  deliberately alongside the scope's own retention, not by surprise.
- `MINIRELAY_MAX_ENTRIES_PER_COORD` (default 1,000,000, also unchanged here)
  remains the per-coordinate cap regardless of retention: a single window for
  one group cannot grow past it even if the sweep is slow or paused.

## How to roll back

Retention is read from the environment at process startup only, so rolling
back is restarting the process without the variable (or with it removed):

```
unset MINIRELAY_SCOPE_RETENTION   # or delete the line from the service's env file
# restart the minirelay process
```

The next sweep (within 60s) returns to treating every scope, including
`zafu-group-v1`, at the single `MINIRELAY_RETENTION_SECONDS` default. No data
migration is needed either direction: retention only decides when the GC
deletes a row, never how a row is stored, so rows written under the longer
retention are simply swept sooner once the override is gone (they do not
become unreadable or need backfilling). If the binary itself needs rolling
back (not just the config), any `minirelay` build without this change reads
`MINIRELAY_SCOPE_RETENTION` as an unknown environment variable - unset is the
same as absent - and behaves exactly as it did before this PR.
