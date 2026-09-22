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
 * OFFERING IT TO FRIENDS
 *
 * A bouncer is most useful run FOR a few people who trust you with their address,
 * so it can be gated and shared:
 *
 *   BOUNCER_TOKENS   comma-separated tokens, one per friend (or one shared). When
 *                    set, every request must present `authorization: Bearer <t>`,
 *                    so your bouncer is not an open proxy for the internet. Give
 *                    each friend their own token and you can revoke one without
 *                    rotating everybody's.
 *   RELAY_TOKEN      the relay's own token, if it has one. The bouncer swaps
 *                    credentials on the way out: the friend's token never reaches
 *                    the relay, and yours never reaches the friend.
 *
 *   BOUNCER_ORIGINS  comma-separated origins allowed to use it from a BROWSER,
 *                    e.g. https://penumbra.fi - so a community can keep its
 *                    bouncer to its own site. Browsers cannot set headers on a
 *                    WebSocket, so the token is also accepted as `?token=` (the
 *                    bouncer strips it before forwarding) or as a cookie it sets
 *                    after one authorized request - which is what makes a gated
 *                    bouncer work for an in-page client with no app changes.
 *                    Origin is a browser-enforced header, so treat the allowlist
 *                    as courtesy, not security: pair it with tokens.
 *
 *   node invite.mjs --url https://your-worker.workers.dev --token <friend's token>
 *
 * prints the snippet to hand over. What you take on by running this: you see your
 * friends' addresses and traffic shape. That is the trade they make by using it,
 * and the reason to log nothing.
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

/** the bearer token a request presented, if any. */
const bearer = headerValue => {
  if (headerValue === null) {
    return null;
  }
  const prefix = 'Bearer ';
  return headerValue.startsWith(prefix) ? headerValue.slice(prefix.length) : null;
};

/** compare without an early exit, so a wrong token cannot be probed byte by byte. */
const sameToken = (a, b) => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/** browser origins allowed to use this bouncer (empty = any). */
const allowedOrigins = env =>
  (env.BOUNCER_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(o => o !== '');

/** the cookie a browser client carries into its WebSocket handshake. */
const TOKEN_COOKIE = 'bouncer_token';

/** CORS headers for responses this bouncer answers itself. */
const corsHeaders = (request, env) => {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins(env);
  const value = allowed.length > 0 ? (origin ?? allowed[0]) : (origin ?? '*');
  return {
    'access-control-allow-origin': value,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
};

const refused = (request, env, status, message) =>
  new Response(`bouncer: ${message}`, { status, headers: corsHeaders(request, env) });

/** the friendly token a request presented: header, `?token=`, or cookie. */
const presentedToken = (request, url) => {
  const header = bearer(request.headers.get('authorization'));
  if (header !== null) {
    return header;
  }
  const query = url.searchParams.get('token');
  if (query !== null && query !== '') {
    return query;
  }
  const cookies = request.headers.get('cookie');
  if (cookies === null) {
    return null;
  }
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === TOKEN_COOKIE) {
      return rest.join('=');
    }
  }
  return null;
};

/** the friend tokens this bouncer accepts (empty = open, which only makes sense locally). */
const friendTokens = env =>
  (env.BOUNCER_TOKENS ?? '')
    .split(',')
    .map(t => t.trim())
    .filter(t => t !== '');

/**
 * Credentials for the upstream hop, kept separate from the inbound ones:
 * the friend's token proves membership HERE and must not travel to the relay;
 * the relay's token (if it has one) is added here and is never seen by friends.
 */
const upstreamHeaders = (headers, env) => {
  const out = new Headers(headers);
  const relayToken = env.RELAY_TOKEN;
  if (relayToken !== undefined && relayToken !== '') {
    out.set('authorization', `Bearer ${relayToken}`);
  } else {
    out.delete('authorization');
  }
  return out;
};

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

    // A browser's preflight never carries credentials, so the token gate cannot
    // apply to it: answer the preflight here and let the real request be judged.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const allowed = allowedOrigins(env);
    const origin = request.headers.get('origin');
    if (allowed.length > 0 && origin !== null && !allowed.includes(origin)) {
      return refused(request, env, 403, 'this bouncer serves one community, not the internet');
    }

    const required = friendTokens(env);
    const authorizedVia = { header: bearer(request.headers.get('authorization')) !== null };
    let authorized = required.length === 0;
    if (!authorized) {
      const presented = presentedToken(request, url);
      authorized = presented !== null && required.some(t => sameToken(presented, t));
      if (!authorized) {
        return refused(request, env, 401, 'this bouncer is for friends of its operator');
      }
    }

    // WebSocket pass-through: forward the upgrade, hand the client the paired
    // socket, and pipe bytes in both directions. The bouncer never parses a frame.
    if (url.pathname.startsWith('/ws/')) {
      const upstream = new URL(url.pathname + url.search, relay);
      upstream.searchParams.delete('token'); // ours, not the relay's
      const headers = upstreamHeaders(request.headers, env);
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
      upstream.searchParams.delete('token'); // ours, not the relay's
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
        headers: upstreamHeaders(request.headers, env),
        body,
        redirect: 'manual',
      });
      const response = await fetch(forwarded);
      if (authorized && !authorizedVia.header) {
        // One authorized request earns the cookie, so this browser's next
        // WebSocket handshake (which cannot carry a header) is recognized too.
        const headers = new Headers(response.headers);
        headers.append(
          'set-cookie',
          `${TOKEN_COOKIE}=${presentedToken(request, url) ?? ''}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=604800`,
        );
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
    }

    return new Response('bouncer: not found', { status: 404 });
  },
};
