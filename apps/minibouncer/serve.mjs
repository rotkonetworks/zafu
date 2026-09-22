#!/usr/bin/env node
/**
 * The bouncer on your own server, for when a Cloudflare Worker is not where you
 * want it - a VPS behind Caddy, a machine you rent, the box that already hosts
 * your community.
 *
 * Same file's rules as `worker.js` (the gates are shared, not reimplemented):
 *
 *   RELAY_URL        where the real relay lives, e.g. https://relay.zafu.pro
 *   RELAY_TOKEN      the relay's own token, if it has one - swapped in on the
 *                    way out, so a friend's token never reaches the relay
 *   BOUNCER_TOKENS   comma-separated tokens friends present (empty = open)
 *   BOUNCER_ORIGINS  comma-separated browser origins allowed (empty = any)
 *
 * HTTP and WebSocket both go through the same two hops; the WS half is a raw
 * pipe - after replaying the handshake with swapped credentials this process
 * stops looking at bytes entirely, which is all a channel needs.
 *
 *   RELAY_URL=https://relay.zafu.pro PORT=8098 node serve.mjs
 *
 * TLS lives in front (Caddy/nginx terminate it and forward here), which is also
 * how the WebSocket upgrade arrives intact. Nothing is logged per request: the
 * one promise a bouncer makes is that no address-to-member mapping exists, and a
 * log would be exactly that mapping. `--verbose` prints method and path only.
 */

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import * as gates from './gates.js';
import worker from './worker.js';

const verbose = process.argv.includes('--verbose');
const env = {
  ...(process.env['RELAY_URL'] ? { RELAY_URL: process.env['RELAY_URL'] } : {}),
  ...(process.env['RELAY_TOKEN'] ? { RELAY_TOKEN: process.env['RELAY_TOKEN'] } : {}),
  ...(process.env['BOUNCER_TOKENS'] ? { BOUNCER_TOKENS: process.env['BOUNCER_TOKENS'] } : {}),
  ...(process.env['BOUNCER_ORIGINS'] ? { BOUNCER_ORIGINS: process.env['BOUNCER_ORIGINS'] } : {}),
};
const relayUrl = env.RELAY_URL ?? 'http://127.0.0.1:8099';
const relay = new URL(relayUrl);
const port = Number(process.env['PORT'] ?? 8098);

if (relay.protocol !== 'https:' && relay.protocol !== 'http:') {
  console.error(`serve: RELAY_URL must be http(s), got ${relayUrl}`);
  process.exit(1);
}

const note = message => {
  if (verbose) {
    console.log(message);
  }
};

/** an undici Request over the same bytes Node gave us, so the Worker's gates apply verbatim. */
const asRequest = req =>
  new Request(`http://${req.headers.host ?? 'bouncer'}${req.url ?? '/'}`, {
    method: req.method,
    headers: req.headers,
  });

/** the upgrade request replayed to the relay, with this hop's credentials and nothing of ours. */
const upgradeToRelay = (req, url) => {
  const skip = new Set(['host', 'authorization', 'cookie']);
  const headers = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    if (skip.has(name.toLowerCase())) {
      continue;
    }
    headers.push(`${name}: ${req.rawHeaders[i + 1]}`);
  }
  headers.push(`Host: ${relay.host}`);
  if (env.RELAY_TOKEN !== undefined) {
    headers.push(`Authorization: Bearer ${env.RELAY_TOKEN}`);
  }
  return `GET ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`;
};

const refuseUpgrade = (socket, status, reason) =>
  socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);

/**
 * The channel half. Bytes in, bytes out: the handshake is replayed to the relay
 * once with swapped credentials, then both sockets are tied together and this
 * process has no further opinion about what flows through them.
 */
const proxyUpgrade = (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'bouncer'}`);
  if (!url.pathname.startsWith('/ws/')) {
    refuseUpgrade(socket, 404, 'Not Found');
    return;
  }
  url.searchParams.delete('token'); // ours, not the relay's
  const request = asRequest(req);

  const allowed = gates.allowedOrigins(env);
  const origin = request.headers.get('origin');
  if (allowed.length > 0 && origin !== null && !allowed.includes(origin)) {
    refuseUpgrade(socket, 403, 'Forbidden');
    return;
  }

  const required = gates.friendTokens(env);
  if (required.length > 0) {
    const presented = gates.presentedToken(request, new URL(request.url));
    if (presented === null || !required.some(t => gates.sameToken(presented, t))) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      return;
    }
  }

  note(`upgrade ${url.pathname}`);

  const upstream =
    relay.protocol === 'https:'
      ? tlsConnect({
          host: relay.hostname,
          port: Number(relay.port || 443),
          servername: relay.hostname,
        })
      : connect({ host: relay.hostname, port: Number(relay.port || 80) });

  const closeBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on('error', closeBoth);
  upstream.on('error', closeBoth);

  upstream.on('connect', () => {
    upstream.write(upgradeToRelay(req, url));
    if (head.length > 0) {
      upstream.write(head); // bytes the client sent right after the handshake
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
};

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);

  try {
    const request = new Request(`http://${req.headers.host ?? 'bouncer'}${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers,
      body,
    });
    const response = await worker.fetch(request, env);
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== 'set-cookie') {
        res.setHeader(name, value);
      }
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
      res.setHeader('set-cookie', cookies); // one header, many cookies - never folded
    }
    res.writeHead(response.status);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    // No address, no member: the message alone is what an operator debugs with.
    console.error(`serve: ${error instanceof Error ? error.message : String(error)}`);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('bouncer: upstream relay did not answer');
  }
});

server.on('upgrade', proxyUpgrade);

server.listen(port, () => {
  const gatesInForce = [
    gates.friendTokens(env).length > 0 ? `${gates.friendTokens(env).length} token(s)` : 'open',
    gates.allowedOrigins(env).length > 0 ? 'origins limited' : 'any origin',
  ].join(', ');
  console.log(`bouncer: http://127.0.0.1:${port} -> ${relay.origin} (${gatesInForce})`);
});
