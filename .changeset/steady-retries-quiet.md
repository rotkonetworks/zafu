---
'@penumbra-zone/query': patch
---

Bound the sync-retry logging. An endpoint that is down used to print an
identical `Sync failure #N` (and, when the tree reset also failed, a second
`Sync tree reset failed`) line on every backoff interval, forever, which buried
the errors that actually need attention. The first three attempts and then
every tenth are now logged; the retry, reset and recovery behaviour is
unchanged and still runs on every attempt.
