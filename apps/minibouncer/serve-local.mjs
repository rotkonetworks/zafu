/**
 * Run the bouncer locally, over plain HTTP, so it can be exercised without a
 * Cloudflare account.
 *
 * The Workers-only piece is the WebSocket branch (`WebSocketPair`); this harness
 * covers the HTTP route the presence layer uses, which is the one that matters for
 * "does my client work through a bouncer unchanged".
 *
 *   RELAY_URL=http://127.0.0.1:8099 node apps/minibouncer/serve-local.mjs
 *   MINIRELAY_URL=http://127.0.0.1:8098 pnpm --filter @zafu/zid test
 *
 * (The second line runs the package's opt-in end-to-end suite through the bouncer
 * instead of against the relay directly - the client cannot tell the difference,
 * which is the point.)
 */

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

import worker from './worker.js';

const relay = process.env['RELAY_URL'] ?? 'http://127.0.0.1:8099';
const port = Number(process.env['PORT'] ?? 8098);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);

  const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers: req.headers,
    body,
  });

  try {
    const response = await worker.fetch(request, { RELAY_URL: relay });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`bouncer harness: ${error instanceof Error ? error.message : String(error)}`);
  }
});

server.listen(port, () => {
  console.log(`minibouncer (local harness): bouncer on http://127.0.0.1:${port} -> relay ${relay}`);
});