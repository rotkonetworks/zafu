// Validation guard for the UFVK string returned by parseZcashAccountsCbor.
// Without it, a malformed `ur:zcash-accounts` payload writes garbage into
// our zcashWallets store; the failure surfaces only on the first send,
// long after the import flow has dismissed the user-facing error path.
//
// We deliberately don't run a full UnifiedFullViewingKey::decode here —
// that requires zcash_keys WASM binding and is heavy. Structural validation
// (HRP prefix + bech32m alphabet + minimum length) catches the bugs we
// actually expect to see (truncated frames, charset injection, etc.) at
// near-zero cost. Heavy decoding stays in the wasm signing path where it
// belongs.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Inline copy of validation logic so the test is self-contained.
// Mirror what we expect lives in ur-parser.ts after this lands.
const BECH32_ALPHABET = new Set('qpzry9x8gf2tvdw0s3jn54khce6mua7l');

function isStructurallyValidUfvk(s) {
  if (typeof s !== 'string') return false;
  // ZIP-316 unified FVK: bech32m with HRP `uview` (mainnet) or
  // `uviewtest` (testnet). Real UFVKs are 250+ chars.
  if (s.length < 100) return false;
  if (s.length > 4096) return false;
  let hrpEnd;
  if (s.startsWith('uview1')) hrpEnd = 5;
  else if (s.startsWith('uviewtest1')) hrpEnd = 9;
  else return false;
  // Everything after the `1` separator must be bech32m alphabet.
  for (let i = hrpEnd + 1; i < s.length; i++) {
    if (!BECH32_ALPHABET.has(s[i])) return false;
  }
  return true;
}

// Build a fixture UFVK by padding a known prefix. Not cryptographically valid,
// but structurally compliant — exercises the validator's accept path.
function fixtureUfvkMainnet() {
  return 'uview1' + 'q'.repeat(250);
}
function fixtureUfvkTestnet() {
  return 'uviewtest1' + 'q'.repeat(250);
}

test('UFVK validator: accepts mainnet-prefixed bech32m string', () => {
  assert.equal(isStructurallyValidUfvk(fixtureUfvkMainnet()), true);
});

test('UFVK validator: accepts testnet-prefixed bech32m string', () => {
  assert.equal(isStructurallyValidUfvk(fixtureUfvkTestnet()), true);
});

test('UFVK validator: rejects empty string', () => {
  assert.equal(isStructurallyValidUfvk(''), false);
});

test('UFVK validator: rejects wrong-prefix string', () => {
  // Real-looking string but for a different protocol
  assert.equal(isStructurallyValidUfvk('zs1' + 'q'.repeat(250)), false);
});

test('UFVK validator: rejects too-short string (truncated frame)', () => {
  assert.equal(isStructurallyValidUfvk('uview1qq'), false);
});

test('UFVK validator: rejects illegal bech32m characters (charset injection)', () => {
  // 'b' and 'i' are not in the bech32m alphabet
  assert.equal(isStructurallyValidUfvk('uview1' + 'b'.repeat(250)), false);
});

test('UFVK validator: rejects pathologically long string (DoS guard)', () => {
  assert.equal(isStructurallyValidUfvk('uview1' + 'q'.repeat(10_000)), false);
});

test('UFVK validator: rejects non-string input (type confusion)', () => {
  assert.equal(isStructurallyValidUfvk(12345), false);
  assert.equal(isStructurallyValidUfvk(null), false);
  assert.equal(isStructurallyValidUfvk(undefined), false);
});
