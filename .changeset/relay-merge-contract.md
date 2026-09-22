---
'@zafu/zid': patch
---

Fix the HTTP relay's wire contract: a `PUT /bucket` must MERGE entries into the
coordinate keyed by tag, not replace the batch.

The doc previously said "store the entries for the coordinate, REPLACING whatever
was there", and the SDK's in-memory test double did exactly that - while
`ContactRelay.publishPresence` never reads before it writes. A relay implemented
from that doc would therefore have kept only the last publisher's batch and
discovery would have surfaced at most one friend per app scope, with every
single-publisher test still passing. The test double now implements merge-by-tag,
and two cases cover what was untested: two publishers writing one coordinate are
both discoverable, and a re-publish does not duplicate a friend. Also documented:
retention (drop past epochs - the presence layer has no forward secrecy, so
history is a liability) and a coordinate cap (a hostile client can append random
tags without limit).

No runtime behaviour changed; the published client already wrote read-free
batches.
