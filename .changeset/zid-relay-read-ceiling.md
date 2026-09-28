---
'@zafu/zid': patch
---

Bound what an untrusted relay can make the SDK buffer. `getBucket` read the
whole response body before `parseEntries` could apply `MAX_RELAY_ENTRIES` /
`MAX_RELAY_ENTRY_BASE64`, so a hostile (or merely broken) relay could still hand
a caller an arbitrarily large body to materialise. Reads now stop at
`MAX_RELAY_BODY_BYTES` (1 MiB - an order of magnitude above the largest legal
bucket) while streaming, and a body that is not JSON is rejected as
`relay: response body is not JSON` instead of surfacing a bare `SyntaxError`.

Also corrects the downgrade docs, which overstated cross-version interop: no zafu
responder emits the protocol-refusal frame yet, and `./channel` (the classical
handshake) parses JSON `keyex` only, so a `'auto'` initiator meeting a
classical-only peer ends in the readiness deadline - which is rethrown, not
downgraded on. `channel: 'classical'` is how that peer is reached.
