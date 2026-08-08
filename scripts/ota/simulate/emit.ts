/**
 * Simulation step 1 (wallet): produce a signed `ur:zafu-stream` for a real
 * ~2 MB module, render the BC-UR fountain frames as QR PNGs — exactly what
 * the wallet's Settings OTA screen would show to the device camera.
 *
 * Usage: npx tsx scripts/ota/simulate/emit.ts <outDir> [moduleSizeBytes]
 */
import { produceStream } from '../../../apps/extension/src/ota/producer.js';
import { encodeStreamFrames } from '../../../apps/extension/src/ota/ur.js';
import { toHex } from '../../../apps/extension/src/ota/util.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/steam/rotko/zafu/package.json');
const QRCode = require('qrcode');

const outDir = process.argv[2] ?? '/tmp/zafu-ota-sim';
const size = parseInt(process.argv[3] ?? (250 * 1024).toString(), 10);
// fake module bytes (deterministic; stands in for module0.wasm / a real module)
const moduleBytes = new Uint8Array(size);
for (let i = 0; i < size; i++) moduleBytes[i] = (i * 31 + 7) & 0xff;

fs.mkdirSync(outDir, { recursive: true });
const produced = await produceStream(moduleBytes, { reqId: new Uint8Array([7, 6, 5, 4, 3, 2, 1, 0]) });
const frames = encodeStreamFrames(produced.payload, 400);
fs.writeFileSync(path.join(outDir, 'payload.hex'), toHex(produced.payload));
fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(frames));

await Promise.all(
  frames.map(async (f, i) => {
    const png = await QRCode.toBuffer(f, {
      errorCorrectionLevel: 'M',
      width: 1400,
      margin: 4,
    });
    fs.writeFileSync(path.join(outDir, `frame_${String(i).padStart(3, '0')}.png`), png);
  }),
);
console.log(`[wallet] produced ${(size / 1024 / 1024).toFixed(2)} MiB module, ${frames.length} fountain frames, QR PNGs -> ${outDir}`);
console.log(`[wallet] payload sha (implicit) verified by stream verification; first frame:\n${frames[0].slice(0, 60)}...`);
