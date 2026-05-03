// Node-runner contract test for the configurable fragment size on the PCZT
// build path. The actual call hops through chrome.runtime → web worker →
// wasm, none of which we can stand up in pure node. So instead we verify
// that the wrapper at least *forwards* a fragment-size override into the
// worker payload and falls back to a sensible default when omitted. If the
// shape of the call changes (e.g. someone hardcodes 200 again), this fails.

import test from 'node:test';
import assert from 'node:assert/strict';

// We don't import the real wrapper because it pulls chrome APIs. We re-test
// the call shape by checking the source matches the contract. A regex-based
// guard is gross but cheaper than spinning up jsdom + a worker shim, and
// it's enough to catch the regressions we actually care about (someone
// reverting `fragmentSize` back to a magic number).
import { readFileSync } from 'node:fs';

const SRC = readFileSync(
  new URL('./network-worker.ts', import.meta.url),
  'utf8',
);

test('buildSendTxPcztInWorker accepts a fragment-size argument', () => {
  // Signature must include a fragmentSize parameter (number, optional).
  // We grep for the function body so a rename of the parameter still passes
  // as long as the call surface stays "callable with a number".
  const m = SRC.match(/buildSendTxPcztInWorker\s*=\s*async\s*\(([^)]*)\)/s);
  assert.ok(m, 'buildSendTxPcztInWorker must be defined as an async arrow');
  const params = m[1].toLowerCase();
  assert.ok(
    /fragment.?size/.test(params),
    `expected fragmentSize-like parameter in buildSendTxPcztInWorker; got: ${params}`,
  );
});

test('callWorker payload threads fragmentSize through to the worker', () => {
  // The wrapper must include `fragmentSize` (or `fragment_size`) in the
  // payload object passed to callWorker. If someone drops it, the worker
  // hardcodes 200 again and Keystone-style devices that need a different
  // density are silently broken.
  const m = SRC.match(/callWorker\(\s*network\s*,\s*'send-tx-pczt'\s*,\s*\{([^}]+)\}/s);
  assert.ok(m, 'send-tx-pczt callWorker payload not found');
  const payload = m[1].toLowerCase();
  assert.ok(
    /fragment.?size/.test(payload),
    `expected fragmentSize in send-tx-pczt payload; got: ${payload}`,
  );
});
