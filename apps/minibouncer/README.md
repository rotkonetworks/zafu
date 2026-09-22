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

|                   |                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **hides**         | your IP address from the relay, and from anyone watching the path to it                                                                                                                                                                      |
| **does not hide** | protocol-level metadata. The relay still sees which app scopes are read, which pubkey pair a channel addresses, and when. Mixing that away is a mixnet problem ([Nym](https://zcash-sdk.nym.com/guidance/) is on the roadmap), not a proxy's |
| **does not hide** | your IP from the bouncer. Run your own - that is why this is one deployable file. On Cloudflare, you are trusting Cloudflare, which is already terminating your HTTP traffic                                                                 |

If you want your own IP out of a _public_ relay's logs, deploy this to your own
workers.dev subdomain and point your wallet at it. If a group shares one bouncer,
they share one address from the relay's point of view - which is often exactly what
a small community wants.

## Offering it to friends, or to a whole community

Run one for the people who trust you with their address. Two bindings shape it:

| binding           | what it does                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOUNCER_TOKENS`  | comma-separated tokens, one per person (or one shared). Every request must then present `authorization: Bearer <t>` - or `?token=` for a browser WebSocket, which cannot set headers. One authorized request also earns an HttpOnly cookie, so the same browser's WebSocket handshake is recognized too |
| `BOUNCER_ORIGINS` | comma-separated origins allowed to use it **from a browser**, e.g. `https://penumbra.fi`. Keeps a community bouncer to its own site. `Origin` is enforced by browsers, so treat this as courtesy rather than security - pair it with tokens                                                             |

```sh
cd apps/minibouncer
npx wrangler deploy
npx wrangler secret put BOUNCER_TOKENS     # e.g. alice:<t1>,bob:<t2>
# optional: BOUNCER_ORIGINS=https://penumbra.fi   (wrangler.toml [vars] or secret)
node invite.mjs --url https://minibouncer.<you>.workers.dev --new --name alice
```

`invite.mjs` prints the handover - a token for `BOUNCER_TOKENS`, the two values for
a wallet's settings fields, and the `zid.connect({...})` call an app pastes in. The
friend needs nothing else: no protocol change, no transport code.

**A community chat, concretely.** If a trading community's site embeds a chat in its
sidebar, the site already runs a server and already sees its members' addresses. Put
a bouncer in front of the relay and every member points at it by default - the app
passes `relayEndpoint` + `relayToken`, or the wallet holds them in settings. Then:

| party                                                      | without a bouncer             | with the community's bouncer                            |
| ---------------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| the relay (its logs, DB, whoever subpoenas or breaches it) | every member's address        | one address for the whole community                     |
| the community's own server                                 | members' addresses, from HTTP | members' addresses, from HTTP _and_ the bouncer         |
| a member's ISP / local network                             | they reach _the relay's host_ | they reach _the bouncer's host_ (custom domain: opaque) |
| a global observer                                          | sees the traffic              | still sees it - mixnet work, not a proxy's              |

That is the whole proposition: **the relay learns no address, and if the bouncer
logs nothing, no mapping from address to member exists anywhere to leak.** Members
stay indistinguishable from each other at the address layer, which a per-person
bouncer would not even achieve - a unique bouncer address is itself a fingerprint.

Two consequences to plan for: per-address rate limits now apply to the community as
one client (raise the relay's budget for that address, and revoke a member by
dropping their token rather than banning the shared address), and the relay can no
longer tell members apart at all - so moderation lives in the bouncer's token list,
not in the relay's.

## For relay operators

Every call arrives from the bouncer's address, so per-address rate limiting becomes
per-bouncer limiting (`MINIRELAY_RATE_LIMIT_PER_MINUTE` in `apps/minirelay`). Use
`MINIRELAY_TOKEN` and give each bouncer its own: the bouncer **swaps** credentials on
the way out - the friend's token never reaches the relay, and the relay's never
reaches the friend. Do not treat source addresses as identity - that is the property
the bouncer exists to break, and it is a property the relay never needed.

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

Gates work locally too - the harness passes the same bindings the Worker reads:

```sh
# a relay that wants a token, and a bouncer that wants a *different* one
cd apps/minirelay && MINIRELAY_PORT=8099 MINIRELAY_TOKEN=relay-owner-token cargo run --release &
cd apps/minibouncer && RELAY_URL=http://127.0.0.1:8099 PORT=8098 \
  BOUNCER_TOKENS=friend-token RELAY_TOKEN=relay-owner-token node serve-local.mjs

# through the bouncer: the friend's token, and no address of theirs upstream
cd packages/zid && MINIRELAY_URL=http://127.0.0.1:8098 MINIRELAY_TOKEN=friend-token pnpm test

curl -X OPTIONS -H 'Origin: https://penumbra.fi' http://127.0.0.1:8098/bucket  # 204, no credentials
curl "http://127.0.0.1:8098/bucket?appScope=x&epoch=1&shard=&token=friend-token" -H 'Origin: https://penumbra.fi'  # 200
curl "http://127.0.0.1:8098/bucket?appScope=x&epoch=1&shard=&token=friend-token" -H 'Origin: https://evil.example'   # 403
curl http://127.0.0.1:8098/bucket?appScope=x\&epoch=1\&shard=                                                  # 401
```

The client cannot tell it is talking to a bouncer - which is the point. Note that
locally both hops share `127.0.0.1`, so the _address_ hiding is structural here (the
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
