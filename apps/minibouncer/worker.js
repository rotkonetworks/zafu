/**
 * minibouncer - an IP bouncer for zafu relays, as a Cloudflare Worker.
 *
 * WHY THIS EXISTS
 *
 * The relay is content-blind, but it is not address-blind: whatever connects to
 * it is visible to its operator (and to anyone watching the path). For presence
 * that means "someone at this address is using the discovery relay"; for pairwise
 * channels it means the relay can associate an address with a pubkey pair. A
 * bouncer terminates YOUR connection and opens its own to the relay, so the relay
 * sees the bouncer's address instead of yours.
 *
 * WHAT IT DOES AND DOES NOT HIDE
 *
 *   hides      your IP address from the relay (and from on-path observers)
 *   does not   hide protocol-level metadata: the relay still sees which app
 *              scopes are read, which pubkey pairs a channel addresses, and when.
 *              Mixing that away is a different problem (a mixnet), not a proxy.
 *   does not   hide your IP from the bouncer. Run your own - that is the point of
 *              shipping this as one deployable file. Cloudflare, which is already
 *              hosting your HTTP traffic, is the party you are trusting here.
 *
 * WHAT A RELAY OPERATOR SHOULD KNOW
 *
 * Every call arrives from the bouncer's address, so per-address rate limits
 * become per-bouncer limits. If a relay wants to keep distinguishing clients, use
 * `MINIRELAY_TOKEN` and have each bouncer present its own token (the
 * `authorization` header is passed through untouched); do not rely on source
 * addresses for identity.
 *
 * DEPLOY
 *
 *   wrangler deploy                     # RELAY_URL from wrangler.toml [vars]
 *
 * Then point clients at the bouncer instead of the relay:
 *
 *   zid.connect({ relayEndpoint: 'https://bouncer.example', relayUrl: 'wss://bouncer.example/ws/zid' })
 *
 * No protocol changes: it forwards `/bucket` (presence) and `/ws/*` (channels)
 * verbatim, so the relay cannot tell a bounced client from a direct one.
 */

const FORWARDED_PREFIXES = ['/bucket'];

export default {
  /**
   * @param {Request} request
   * @param {{ RELAY_URL?: string }} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const relay = env.RELAY_URL;
    if (relay === undefined || relay === '') {
      return new Response('bouncer: RELAY_URL is not configured', { status: 500 });
    }

    // WebSocket pass-through: forward the upgrade, hand the client the paired
    // socket, and pipe bytes in both directions. The bouncer never parses a frame.
    if (url.pathname.startsWith('/ws/')) {
      const upstream = new URL(url.pathname + url.search, relay);
      const headers = new Headers(request.headers);
      headers.set('Upgrade', 'websocket');

      const response = await fetch(upstream, { method: 'GET', headers });
      const upstreamSocket = response.webSocket;
      if (upstreamSocket === undefined || upstreamSocket === null) {
        return new Response('bouncer: upstream did not upgrade to websocket', { status: 502 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      upstreamSocket.accept();

      server.addEventListener('message', event => upstreamSocket.send(event.data));
      upstreamSocket.addEventListener('message', event => server.send(event.data));
      const close = () => {
        try {
          server.close();
        } catch {
          /* already closed */
        }
        try {
          upstreamSocket.close();
        } catch {
          /* already closed */
        }
      };
      server.addEventListener('close', close);
      upstreamSocket.addEventListener('close', close);

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP pass-through for the presence relay's two routes.
    if (FORWARDED_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
      const upstream = new URL(url.pathname + url.search, relay);
      // No X-Forwarded-For, deliberately: the whole point is that the relay does
      // not learn the client's address. Adding one would undo this file.
      //
      // The body is buffered rather than streamed: a presence batch is a bounded
      // JSON document (the relay caps it), and a streamed body needs runtime-specific
      // plumbing (`duplex: 'half'` in Node, unnecessary in Workers) that would make
      // this file behave differently on the two runtimes it is meant to run on.
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request.arrayBuffer();
      const forwarded = new Request(upstream.toString(), {
        method: request.method,
        headers: request.headers,
        body,
        redirect: 'manual',
      });
      return fetch(forwarded);
    }

    return new Response('bouncer: not found', { status: 404 });
  },
};