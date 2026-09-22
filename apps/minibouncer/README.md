# minibouncer

An IP bouncer for zafu relays: **one Cloudflare Worker, no dependencies, ~2 minute
deploy**. It terminates your connection and opens its own to the relay, so the
relay sees the bouncer's address instead of yours.

```sh
cd apps/minibouncer
# set RELAY_URL in wrangler.toml to your relay (e.g. https://relay.example)
npx wrangler deploy
```

Then point clients at the bouncer instead of the relay - no protocol change, the
bouncer forwards `/bucket` (presence) and `/ws/*` (channels) verbatim:

```ts
await zid.connect({
  relayEndpoint: 'https://minibouncer.<you>.workers.dev',
  relayUrl: 'wss://minibouncer.<you>.workers.dev/ws/zid',
});
```

## What it hides, and what it does not

| | |
| --- | --- |
| **hides** | your IP address from the relay, and from anyone watching the path to it |
| **does not hide** | protocol-level metadata. The relay still sees which app scopes are read, which pubkey pair a channel addresses, and when. Mixing that away is a mixnet problem ([Nym](https://zcash-sdk.nym.com/guidance/) is on the roadmap), not a proxy's |
| **does not hide** | your IP from the bouncer. Run your own - that is why this is one deployable file. On Cloudflare, you are trusting Cloudflare, which is already terminating your HTTP traffic |

If you want your own IP out of a *public* relay's logs, deploy this to your own
workers.dev subdomain and point your wallet at it. If a group shares one bouncer,
they share one address from the relay's point of view - which is often exactly what
a small community wants.

## For relay operators

Every call arrives from the bouncer's address, so per-address rate limiting becomes
per-bouncer limiting (`MINIRELAY_RATE_LIMIT_PER_MINUTE` in `apps/minirelay`). If a
relay wants to keep distinguishing clients behind a bouncer, use `MINIRELAY_TOKEN`:
the `authorization` header is passed through untouched, so each bouncer can present
its own token. Do not treat source addresses as identity - that is the property the
bouncer exists to break, and it is a property the relay never needed.

## Check it locally

The HTTP route runs outside Workers, so the whole chain (client -> bouncer -> relay)
can be exercised on one machine:

```sh
# 1. a relay
cd apps/minirelay && MINIRELAY_PORT=8099 MINIRELAY_DB=/tmp/relay.sqlite cargo run --release &

# 2. the bouncer, in front of it
cd apps/minibouncer && RELAY_URL=http://127.0.0.1:8099 PORT=8098 node serve-local.mjs

# 3. the SDK's opt-in end-to-end suite, through the bouncer
cd packages/zid && MINIRELAY_URL=http://127.0.0.1:8098 pnpm test
```

The client cannot tell it is talking to a bouncer - which is the point. Note that
locally both hops share `127.0.0.1`, so the *address* hiding is structural here (the
relay only ever sees the connection it serves) rather than observable.

## Roadmap: the IRC-BNC half

IRC bouncers also keep you connected and buffer history while you are offline.
That is store-and-forward, and it belongs on top of this rather than inside it: a
bouncer that buffers would hold ciphertext it cannot read (fine, it is a relay
too), and would need a per-user subscription and a delivery cursor. Two things to
decide first: who may attach to a buffer (an app-scoped handle is the natural key)
and how long a buffer lives (the same retention question the presence relay
answers with "one epoch").

## License

MIT