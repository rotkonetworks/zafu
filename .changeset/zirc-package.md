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
