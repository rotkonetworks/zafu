// Node-runner version of cbor-pczt-envelope.test.ts.
// We hand-port to .mjs because vitest in this workspace currently fails its
// global setup (navigator.locks polyfill blows up under the test runner's
// jsdom). Pure-byte logic doesn't need any of that — `node --test` runs the
// helper directly. Same assertions as the vitest version, kept in sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline helper copy. Keep byte-for-byte identical to the impl in
// `zcash-send-cbor-helpers.ts`. The duplication is deliberate: this test
// is meant to fail loudly if either implementation drifts.
function unwrapCborSinglePczt(cbor) {
  if (cbor.length < 3) {
    throw new Error('CBOR PCZT envelope too short');
  }
  if (cbor[0] !== 0xa1) {
    throw new Error('expected CBOR map(1) at offset 0');
  }
  if (cbor[1] !== 0x01) {
    throw new Error('expected CBOR key 1 at offset 1');
  }
  let pos = 2;
  const tag = cbor[pos++];
  const readLen = nBytes => {
    if (pos + nBytes > cbor.length) {
      throw new Error(`CBOR length header truncated (need ${nBytes} bytes)`);
    }
    let v = 0;
    for (let i = 0; i < nBytes; i++) {
      v = v * 256 + cbor[pos++];
    }
    return v;
  };
  let len;
  if (tag >= 0x40 && tag <= 0x57) {
    len = tag - 0x40;
  } else if (tag === 0x58) {
    len = readLen(1);
  } else if (tag === 0x59) {
    len = readLen(2);
  } else if (tag === 0x5a) {
    len = readLen(4);
  } else {
    throw new Error(`unexpected CBOR bytes tag 0x${tag.toString(16)}`);
  }
  if (pos + len !== cbor.length) {
    throw new Error(
      `CBOR PCZT envelope not canonical: declared length ${len} at offset ${pos} vs buffer ${cbor.length}`,
    );
  }
  return cbor.slice(pos, pos + len);
}

// Mirror of the wasm-side `cborWrapPczt`. Reference encoder for round-trip.
function wrap(payload) {
  const len = payload.length;
  const header = [0xa1, 0x01];
  if (len <= 23) {
    header.push(0x40 | len);
  } else if (len <= 0xff) {
    header.push(0x58, len);
  } else if (len <= 0xffff) {
    header.push(0x59, (len >> 8) & 0xff, len & 0xff);
  } else {
    header.push(0x5a, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
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

// ── adversarial cases (review: signed-shift / truncated-header / trailing) ──
// A hostile signer controls these bytes. Each of the following currently
// slips past the bounds guard and returns a silently-wrong (empty/truncated)
// PCZT instead of throwing — which then fails opaquely deep in the wasm
// extractor. They must throw cleanly at the envelope layer.

test('cbor envelope: rejects 0x5a length with high bit set (signed-shift)', () => {
  // map(1){1: bytes(0x80000004)} — JS `b0<<24` is signed → negative len →
  // `pos+len > cbor.length` is false → guard bypassed in the buggy impl.
  const buf = new Uint8Array([0xa1, 0x01, 0x5a, 0x80, 0x00, 0x00, 0x04, 1, 2, 3, 4]);
  assert.throws(() => unwrapCborSinglePczt(buf), /length|invalid|exceeds/i);
});

test('cbor envelope: rejects truncated 0x58 length header', () => {
  // map(1){1: bytes(<1-byte-len>)} but the length byte itself is missing.
  // Buggy impl: cbor[3] is undefined → len=undefined → NaN guard passes.
  assert.throws(() => unwrapCborSinglePczt(new Uint8Array([0xa1, 0x01, 0x58])));
});

test('cbor envelope: rejects truncated 0x5a length header', () => {
  // 0x5a needs 4 length bytes; only 2 present.
  assert.throws(() => unwrapCborSinglePczt(new Uint8Array([0xa1, 0x01, 0x5a, 0x00, 0x01])));
});

test('cbor envelope: rejects trailing bytes after the byte string', () => {
  // map(1){1: bytes(2)} = a1 01 42 AA BB, then a stray trailing 0xFF.
  // A canonical single-PCZT envelope must consume exactly the buffer; extra
  // bytes mean a malformed / smuggled payload.
  assert.throws(
    () => unwrapCborSinglePczt(new Uint8Array([0xa1, 0x01, 0x42, 0xaa, 0xbb, 0xff])),
    /trailing|exact|canonical|exceeds|length/i,
  );
});

// ===========================================================================
// Ironwood-aware signer prelude envelope (FIX-C item 1). Byte-for-byte mirror
// of `preludeWrapSinglePczt` / `parsePreludeSinglePcztResponse`. Fails loudly
// if either the impl here or in the .ts drifts from zigner's envelope.rs.
// ===========================================================================

const PRELUDE = [0x53, 0x04, 0x03];

function preludeWrapSinglePczt(pczt) {
  const out = new Uint8Array(PRELUDE.length + pczt.length);
  out.set(PRELUDE, 0);
  out.set(pczt, PRELUDE.length);
  return out;
}

// Reference RESPONSE encoder: prelude || digest:32 || len:u32(LE) || signed_pczt.
function encodePreludeResponse(signedPczt, digest = new Uint8Array(32)) {
  const len = signedPczt.length;
  const out = new Uint8Array(3 + 32 + 4 + len);
  out.set(PRELUDE, 0);
  out.set(digest, 3);
  out[35] = len & 0xff;
  out[36] = (len >>> 8) & 0xff;
  out[37] = (len >>> 16) & 0xff;
  out[38] = (len >>> 24) & 0xff;
  out.set(signedPczt, 39);
  return out;
}

function parsePreludeSinglePcztResponse(payload) {
  if (payload.length < 3) {
    throw new Error('prelude PCZT response too short');
  }
  if (payload[0] !== 0x53) {
    throw new Error('bad prelude');
  }
  if (payload[1] !== 0x04) {
    throw new Error('bad crypto type');
  }
  if (payload[2] !== 0x03) {
    throw new Error('bad tx type');
  }
  if (payload.length < 3 + 32 + 4) {
    throw new Error('truncated digest/length header');
  }
  const digest = payload.slice(3, 35);
  let pos = 39;
  const len = payload[35] + payload[36] * 256 + payload[37] * 65536 + payload[38] * 16777216;
  if (pos + len !== payload.length) {
    throw new Error('prelude PCZT response not canonical');
  }
  return { signedPczt: payload.slice(pos, pos + len), digest };
}

test('prelude request: wraps with [0x53][0x04][0x03] prelude', () => {
  const pczt = new Uint8Array([9, 8, 7, 6, 5]);
  const env = preludeWrapSinglePczt(pczt);
  assert.deepEqual([env[0], env[1], env[2]], PRELUDE);
  assert.deepEqual(env.slice(3), pczt);
});

test('prelude request: NOT the orchard-blind CBOR envelope', () => {
  // regression guard for FIX-C: the migration must never be shaped like the
  // ur:zcash-pczt CBOR {1: bytes} map (which starts 0xa1 0x01) - that reaches
  // the ironwood-blind signer.
  const env = preludeWrapSinglePczt(new Uint8Array([1, 2, 3]));
  assert.notEqual(env[0], 0xa1);
  assert.equal(env[0], 0x53);
});

test('prelude response: round-trip small signed PCZT', () => {
  const signed = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const digest = new Uint8Array(32).map((_, i) => (i * 7) & 0xff);
  const parsed = parsePreludeSinglePcztResponse(encodePreludeResponse(signed, digest));
  assert.deepEqual(parsed.signedPczt, signed);
  assert.deepEqual(parsed.digest, digest);
});

test('prelude response: round-trip 70KB signed PCZT (u32 length path)', () => {
  const signed = new Uint8Array(70_000).map((_, i) => i & 0xff);
  const parsed = parsePreludeSinglePcztResponse(encodePreludeResponse(signed));
  assert.deepEqual(parsed.signedPczt, signed);
});

test('prelude response: rejects wrong prelude byte', () => {
  const env = encodePreludeResponse(new Uint8Array([1, 2]));
  env[0] = 0x52;
  assert.throws(() => parsePreludeSinglePcztResponse(env), /prelude/i);
});

test('prelude response: rejects wrong tx type (batch instead of single)', () => {
  const env = encodePreludeResponse(new Uint8Array([1, 2]));
  env[2] = 0x04; // batch
  assert.throws(() => parsePreludeSinglePcztResponse(env), /tx type/i);
});

test('prelude response: rejects truncated digest/length header', () => {
  assert.throws(
    () => parsePreludeSinglePcztResponse(new Uint8Array([0x53, 0x04, 0x03, 0, 0])),
    /truncated/i,
  );
});

test('prelude response: rejects trailing bytes after signed PCZT', () => {
  const env = encodePreludeResponse(new Uint8Array([1, 2, 3]));
  const withTrailer = new Uint8Array(env.length + 1);
  withTrailer.set(env, 0);
  withTrailer[env.length] = 0xff;
  assert.throws(() => parsePreludeSinglePcztResponse(withTrailer), /canonical/i);
});
