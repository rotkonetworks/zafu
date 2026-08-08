#!/usr/bin/env node
/**
 * Dev-only static server for the Zafu OTA "check for update" flow.
 *
 * Serving it is what makes the wallet's Settings → OTA screen actually resolve
 * (the wallet's `checkForUpdate` GETs OTA_FETCH_URL and expects JSON
 * `{ "payloadHex": "..." }` = a fully-signed `ur:zafu-stream`).
 *
 * The stream JSON is produced by the dev producer (run the vitest
 * `producer.test.ts`, which writes `apps/extension/src/ota/test-data/dev-stream.json`),
 * or by `scripts/ota/ota-pack.mjs` from a real module/wasm file.
 *
 * Usage: node scripts/ota/ota-dev-server.mjs [--port 8787] [--file path/to/dev-stream.json]
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const port = parseInt(process.argv[process.argv.indexOf('--port') + 1] ?? '8787', 10);
const file =
  process.argv[process.argv.indexOf('--file') + 1] ??
  path.join(import.meta.dirname, '..', '..', 'apps/extension/src/ota/test-data/dev-stream.json');

let stream;
try {
  stream = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`[ota-dev] no stream artifact at ${file}`);
  console.error(
    '[ota-dev] generate one first: run the boolean "ota producer" vitest, or scripts/ota/ota-pack.mjs',
  );
  process.exit(1);
}

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('content-type', 'application/json');
  res.end(stream);
  console.log(
    `[ota-dev] served ${req.method} ${req.url} (${(stream.length / 1024).toFixed(0)} KB stream json)`,
  );
}).listen(port, () => {
  console.log(`[ota-dev] Zafu OTA dev endpoint up at http://localhost:${port}/zafu/ota/v1/stream`);
});
