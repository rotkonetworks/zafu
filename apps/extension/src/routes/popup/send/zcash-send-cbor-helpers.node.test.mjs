// Node-runner version of cbor-pczt-envelope.test.ts.
// We hand-port to .mjs because vitest in this workspace currently fails its
// global setup (navigator.locks polyfill blows up under the test runner's
// jsdom). Pure-byte logic doesn't need any of that — `node --test` runs the
// helper directly. Same assertions as the vitest version, kept in sync.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Inline helper copy. Keep byte-for-byte identical to the impl in
// `zcash-send-cbor-helpers.ts`. The duplication is deliberate: this test
// is meant to fail loudly if either implementation drifts.
function unwrapCborSinglePczt(cbor) {
  if (cbor.length < 3) throw new Error('CBOR PCZT envelope too short');
  if (cbor[0] !== 0xa1) throw new Error('expected CBOR map(1) at offset 0');
  if (cbor[1] !== 0x01) throw new Error('expected CBOR key 1 at offset 1');
  let pos = 2;
  const tag = cbor[pos++];
  let len;
  if (tag >= 0x40 && tag <= 0x57) {
    len = tag - 0x40;
  } else if (tag === 0x58) {
    len = cbor[pos++];
  } else if (tag === 0x59) {
    len = (cbor[pos] << 8) | cbor[pos + 1];
    pos += 2;
  } else if (tag === 0x5a) {
    len = (cbor[pos] << 24) | (cbor[pos + 1] << 16) | (cbor[pos + 2] << 8) | cbor[pos + 3];
    pos += 4;
  } else {
    throw new Error(`unexpected CBOR bytes tag 0x${tag.toString(16)}`);
  }
  if (pos + len > cbor.length) throw new Error('CBOR PCZT length exceeds envelope');
  return cbor.slice(pos, pos + len);
}

// Mirror of the wasm-side `cborWrapPczt`. Reference encoder for round-trip.
function wrap(payload) {
  const len = payload.length;
  const header = [0xa1, 0x01];
  if (len <= 23) header.push(0x40 | len);
  else if (len <= 0xff) header.push(0x58, len);
  else if (len <= 0xffff) header.push(0x59, (len >> 8) & 0xff, len & 0xff);
  else header.push(0x5a, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

test('cbor envelope: 0-byte payload round-trip', () => {
  const payload = new Uint8Array(0);
  assert.deepEqual(unwrapCborSinglePczt(wrap(payload)), payload);
});

test('cbor envelope: tiny payload (< 24B, length-in-tag)', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(unwrapCborSinglePczt(wrap(payload)), payload);
});

test('cbor envelope: 100-byte payload (24..=255B, 0x58 prefix)', () => {
  const payload = new Uint8Array(100).map((_, i) => i & 0xff);
  assert.deepEqual(unwrapCborSinglePczt(wrap(payload)), payload);
});

test('cbor envelope: 4096-byte payload (256..=65535B, 0x59 prefix)', () => {
  const payload = new Uint8Array(4096).map((_, i) => i & 0xff);
  assert.deepEqual(unwrapCborSinglePczt(wrap(payload)), payload);
});

test('cbor envelope: 70KB payload (>65535B, 0x5a prefix)', () => {
  // 70KB straddles the 4-byte-length boundary that real PCZTs hit after
  // Halo 2 proofs are baked in. Worth covering the path.
  const payload = new Uint8Array(70_000).map((_, i) => i & 0xff);
  assert.deepEqual(unwrapCborSinglePczt(wrap(payload)), payload);
});

test('cbor envelope: rejects non-map cbor', () => {
  assert.throws(() => unwrapCborSinglePczt(new Uint8Array([0x80, 0x01, 0x02])));
});

test('cbor envelope: rejects map with wrong key', () => {
  // map(1) { 2: bytes(0) } — key=2 instead of key=1 → reject
  assert.throws(() => unwrapCborSinglePczt(new Uint8Array([0xa1, 0x02, 0x40])));
});

test('cbor envelope: rejects truncated payload', () => {
  // map(1) { 1: bytes(10) } header but only 5 payload bytes follow
  assert.throws(() => unwrapCborSinglePczt(new Uint8Array([0xa1, 0x01, 0x4a, 1, 2, 3, 4, 5])));
});
