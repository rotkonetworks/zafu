---
'@zafu/zirc': minor
'@zafu/zid': minor
---

- **@zafu/zirc** (new): IRC-style channels on zid, as a client library with no
  network in it. Genesis, a hash-chained log of modes and votes, authority
  verification, the electorate at a log index, and tallies that say why a decision
  passed - or why an individual vote was not counted. Moderation here **hides
  rather than deletes**, and every number is recomputable by anyone holding the
  same records.
- **@zafu/zid**: gains the group session shipped for coordination - round-structured
  fan-out over the pairwise channels, with an envelope signed over group, round and
  payload so a forged or replayed round message is rejected locally - plus the
  canonical signed-byte encoding (`signedFields` and friends) as public API, so a
  second implementation in another language can recompute exactly the bytes this
  SDK signs.
- **@zafu/zirc** room: a room's board is addressed by a shard derived from the
  room **secret**, so a channel name is a label and not a discoverable address -
  one name is one room per secret, and boards cannot be enumerated by guessing
  names. `public: true` puts a room on the name's shard on purpose, for rooms
  meant to be found by someone holding no key. The invite codec carries the flag
  (`zroom2` gains a `p` field, and a token with no relay no longer lands in the
  endpoint slot), and a pinned `shard` still overrides both modes.
- **@zafu/zirc** custody registry: a `custody` record puts the multisig roster in
  the same hash-chained log rather than in a setting, so there is no second source
  of truth - `custodyStateAt` derives the roster in force plus `added`/`removed`
  per rotation, and `custodyProblems` refuses a roster a ceremony could not run
  (unknown scheme, malformed fingerprint, threshold outside 1..n, duplicate or
  non-hex ed25519 identities). It is authorized like a vote, and `epoch` must
  strictly advance, so an old roster cannot roll a multisig back. The `/frost`
  commands are the client-side control plane over those records: `show`, `roster
k-of-n <nick|id>…` (names resolved against the room, with completion that offers
  the members not yet listed), `verify <fingerprint>`, and `rotate`. It records who
  _would_ sign; it does not run FROST.
