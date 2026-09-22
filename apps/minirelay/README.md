# minirelay

The presence relay for zafu's private contact discovery. Two routes over one
SQLite table, no crypto, no accounts, no per-tag lookup.

It exists because `@zafu/zid` ships the client half of discovery
(`createHttpRelayTransport`) and the protocol needs somewhere to point it. The
relay is deliberately the dumbest thing that satisfies the contract - everything
that makes discovery private happens on the clients, which publish opaque 16-byte
tags and 64-byte sealed blobs and read the whole bucket for an app scope.

**Not a package.** The client lives in `@zafu/zid`; this is a service you run, so
that anyone can point a wallet at their own.

## Run it

```sh
cargo run --release                     # listens on :8080, SQLite in ./minirelay.sqlite

# or, with docker:
docker build -t minirelay .
docker run -d --name minirelay -p 8080:8080 -v minirelay-data:/data minirelay
```

Point the wallet at it: settings → privacy → private contact discovery → relay
endpoint, e.g. `https://relay.example.org`. The client appends `/bucket`, so the
endpoint is the base URL, not the route.

## The contract

Exactly what `packages/zid/src/relay-http.ts` sends and expects:

```
POST /bucket          { appScope, epoch, shard, entries: [{ tag, blob }] }   (base64 bytes)
                 ->   204 No Content. MERGES the entries into the coordinate,
                      keyed by tag. A coordinate holds one padded batch PER
                      PUBLISHER, so a replace would drop everyone but the last
                      writer and discovery would surface at most one friend.

GET  /bucket?appScope=…&epoch=…&shard=…
                 ->   200 { entries: [{ tag, blob }] }   the WHOLE coordinate,
                      empty array when nothing is published.

GET  /health     ->   200 "ok"
```

Two properties are load-bearing and easy to get wrong:

- **Whole-coordinate reads only.** There is deliberately no per-tag route. A
  relay that could answer "give me this tag" would let its operator watch which
  tags a client asks for and rebuild social-graph edges even though every tag is
  opaque - it would defeat the point of the transport.
- **Merge, never replace.** Tags are unique per publisher+epoch by construction,
  so merging keyed by tag makes a retry idempotent for a publisher's own entries
  while leaving everyone else's alone.

## What the operator sees

Plainly, because it decides who should run one:

- source addresses, timings, and which `(app_scope, epoch)` is read or written;
- **not** the meaning of anything: tags and blobs are opaque, and blobs are AEAD
  ciphertext under pairwise secrets the relay never holds. It cannot forge an
  entry either - a client would fail to open it;
- but it **can withhold** entries, and a client cannot detect that. Run your own,
  or run one you would trust to be merely unavailable rather than hostile.

The log line deliberately omits the query string: writing `(app_scope, epoch)` to
disk would build exactly the index the protocol refuses to keep.

## Configuration

| variable                          | default            | notes                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MINIRELAY_PORT`                  | `8080`             |                                                                                                                                                                                                                                        |
| `MINIRELAY_DB`                    | `minirelay.sqlite` | SQLite file; WAL mode                                                                                                                                                                                                                  |
| `MINIRELAY_RETENTION_SECONDS`     | `3600`             | entries older than this are swept every 60s. Tags rotate every epoch, so old rows are unreadable to clients - and this layer has no forward secrecy by design, so keeping history only lengthens the window for a later key compromise |
| `MINIRELAY_MAX_ENTRIES_PER_COORD` | `1000000`          | a hostile client can append random tags without limit, so this bounds everyone's download. Honest usage is `publishers × 64` per coordinate                                                                                            |
| `MINIRELAY_MAX_ENTRIES_PER_PUT`   | `4096`             | must stay above the protocol's padding constant (64): a client sends its whole padded batch in one request, and splitting it would change the write shape and leak friend counts                                                       |
| `MINIRELAY_MAX_BODY_BYTES`        | `8388608`          |                                                                                                                                                                                                                                        |
| `MINIRELAY_ALLOW_ORIGIN`          | `*`                | the protocol carries no credentials, so any origin may read; tighten only if you know your clients                                                                                                                                     |

Put TLS in front (haproxy/nginx) - the client is a browser and will otherwise
refuse a mixed-content request from an https page.

## Extending it: policy as layers

The relay is built as a server-as-a-function, in tower's vocabulary (the same
shape as `docs/services-pattern.md` and `@zafu/service` on the TypeScript side):

```
Service   src/service.rs   one request in, one response out
Layer     src/service.rs   wraps a Service in another Service
strategy  src/strategy.rs  the stack this configuration asks for
```

Every layer is present in the stack and no-ops when it is not configured, so
`RelayService` stays a concrete type and "policy off" is a no-op rather than a
different composition. The base service (`StoreService`) is the only I/O leaf;
layers never touch SQLite, they decide what reaches it.

Built in, all configuration-driven:

| layer           | env                               | what it decides                                                         |
| --------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `observe`       | _always on_                       | one log line per call, never a coordinate                               |
| `require_token` | `MINIRELAY_TOKEN`                 | who may use this relay (any caller must send `authorization: Bearer …`) |
| `allow_scopes`  | `MINIRELAY_ALLOWED_SCOPES`        | which app scopes it serves, i.e. one community's namespace              |
| `rate_limit`    | `MINIRELAY_RATE_LIMIT_PER_MINUTE` | how fast a source may ask (per-IP sliding window)                       |

Adding your own is a `Layer` + `Service` pair over `RelayRequest`, then one line
in `strategy::build`. It will be measured by `observe` if you put it below it, it
can refuse with a `RelayError`, and it still cannot reach the store.

The client needs no change for any of this: a token is a header
(`createHttpRelayTransport({ endpoint, headers })`), scopes are the app's own
string, and refusals are plain HTTP status codes (401/403/429).

### What a relay cannot do: moderate people

Layers can gate the door. They cannot identify anyone inside, and this is worth
being blunt about because it is the first thing someone wants to add:

- an entry is an opaque 16-byte tag and a sealed 64-byte blob. There is no user
  id in it, tags rotate every epoch and are unlinkable across epochs, and the
  blob opens only under a pairwise secret the relay never holds. So a layer
  cannot ban a user, count anyone's friends, or attribute an entry to a person -
  not as a limitation of this implementation, but because that information is not
  in the data;
- it _can_ withhold entries or drop a whole coordinate, which is blunt, affects
  everyone at that coordinate, and is undetectable by clients;
- and it can refuse a _source address_, which is coarse (NAT shares addresses)
  and unrelated to identity.

Moderation needs identities, so it belongs one layer up, in the application:

- **attribution**: an action can carry a signature by the actor's site-scoped key
  (`@zafu/zid`'s `sign`), which any party can verify and no relay can forge;
- **scoped identity**: `computeHandle` already derives an app-scoped handle from a
  key (`SHA-256("<pubkey>:<appScope>:zid:contact:v1")`), so a community server can
  recognise the same member across actions in _its_ scope while the same person is
  unlinkable in every other app;
- **enforcement**: the community server refuses service, or publishes its own
  blocklist, and the relay stays the dumb store it is;
- **the hard part is not cryptography**: identities here are free to mint - a
  wallet-free guest is one seed away - so a ban is a speed bump unless the
  identity costs something. Accountability comes from invites, a stake, or a
  position in someone's contact graph, not from a signature check.

## Tests

```sh
cargo test                                   # store + HTTP contract, no network

# the cross-language contract check: the real TS client against this server
cargo run --release &                        # or: docker run -p 8080:8080 …
cd ../../packages/zid
MINIRELAY_URL=http://127.0.0.1:8080 pnpm test
```

The second one is the only test that exercises the contract against a second
implementation rather than a TypeScript double, which is exactly where a
doc/implementation mismatch (merge vs replace) hides. It is skipped without
`MINIRELAY_URL`, so the package's own suite stays hermetic.

## Scaling

Reads are the whole coordinate, so download size is linear in publishers:
`publishers × 64 entries × 80 bytes` per app scope per epoch - about 5 MB at
1,000 publishers, 51 MB at 10,000. That is the design's cost, not this
implementation's, and it is why the protocol targets thousands per app scope
rather than millions. Past that, prefix sharding (already supported by the
client) divides it, and fuzzy message detection is the documented escape hatch -
see the design notes in the issue tracker. One connection serializes writes;
at this scale that is not the constraint.
