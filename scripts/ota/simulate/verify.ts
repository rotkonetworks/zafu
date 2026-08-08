/**
 * Simulation step 3 (wallet-side + result): take the UR strings recovered by
 * the "camera" (decode_frames.py), reassemble via BC-UR fountain, verify the
 * stream against the pinned key, and — standing in for the device — sign a
 * `ur:zafu-result` and have the wallet verify it.
 *
 * Usage: npx tsx scripts/ota/simulate/verify.ts <outDir>
 */
import { decodeStream } from '../../../apps/extension/src/ota/ur.js';
import { verifyStream } from '../../../apps/extension/src/ota/stream.js';
import { verifyResult } from '../../../apps/extension/src/ota/signature.js';
import { encodeMap, encodeBool } from '../../../apps/extension/src/ota/canonical.js';
import { DOMAINS } from '../../../apps/extension/src/ota/signature.js';
import { sha256, hexToBytes, toHex } from '../../../apps/extension/src/ota/util.js';
import { concat } from '../../../apps/extension/src/ota/canonical.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { ed25519 } = createRequire('/steam/rotko/zafu/package.json')('@noble/curves/ed25519');

const outDir = process.argv[2] ?? '/tmp/zafu-ota-sim';
const urParts = JSON.parse(fs.readFileSync(path.join(outDir, 'ur_parts.json'), 'utf8'));
const expectedPayload = fs.readFileSync(path.join(outDir, 'payload.hex'), 'utf8');

const reassembled = decodeStream(urParts);
const got = toHex(reassembled);
if (got !== expectedPayload.trim()) {
  throw new Error(
    '[verify] FAIL: reassembled payload differs from what the wallet produced (fountain/camera mismatch)',
  );
}
console.log(
  `[verify] fountain reassembly OK (${(reassembled.length / 1024 / 1024).toFixed(2)} MiB)`,
);

// wallet verifies the stream against the pinned key (it never signs)
const { manifest, imageHeader } = verifyStream(reassembled);
console.log(
  `[verify] stream VERIFIED against pinned key: v${manifest.version} board=${manifest.board} class=${manifest.class} sha=${toHex(manifest.payload_sha256).slice(0, 16)}…`,
);

// --- device-standing turn: sign a ur:zafu-result with a ZID key ---
// (mirrors rust/ota result::produce_result; deterministic dev zid key)
const zidSecret = await sha256(new TextEncoder().encode('zafu-ota-sim-device-zid::dev-only'));
const zidPub = ed25519.getPublicKey(zidSecret);
const canonical = encodeMap([
  [1, manifest.version],
  [2, true],
  [3, 'B'],
  [4, manifest.req_id],
  [5, zidPub],
]);
const sig = ed25519.sign(concat(DOMAINS.result, canonical), zidSecret);
const ok = verifyResult(canonical, zidPub, sig);
if (!ok) throw new Error('[verify] FAIL: wallet rejected the device-signed result');
console.log(
  `[verify] device-signed ur:zafu-result accepted by wallet (slot B, fw v${manifest.version})`,
);
console.log(
  '[simulate] FULL LOOP OK: wallet→QR→camera→fountain→verify→result→verify all on PC (no phone)',
);
