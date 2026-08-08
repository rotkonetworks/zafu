/**
 * Producer (end-to-end delivery) test: prove a REAL multi-MB signed module
 * stream can be produced, verified by the wallet, and round-tripped through
 * the BC-UR fountain — i.e. that "1-3 MB module over QR" actually works in
 * zafu, not just the receiving skeleton.
 *
 * Also writes `test-data/dev-stream.json` that a dev server can serve at the
 * OTA_FETCH_URL path so the Settings OTA screen's "check for update" resolves.
 */
import { describe, it, expect } from 'vitest';
import { produceStream } from './producer';
import { verifyStream } from './stream';
import { PINNED_OTA_PUBLIC_KEY } from './keys';
import { encodeStreamFrames, decodeStream, decodeSinglePart } from './ur';
import fs from 'node:fs';
import path from 'node:path';

// A realistic ~2 MB signed protocol module image (matches the product's
// "1-3 MB module over QR, ~1-2 min scan" target).
function fakeModule(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe('ota producer end-to-end', () => {
  it('produces a verified ~2 MB stream the wallet accepts', async () => {
    const moduleBytes = fakeModule(2 * 1024 * 1024);
    const reqId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const produced = await produceStream(moduleBytes, { reqId, version: '0.9.0' });

    expect(produced.manifestSig.length).toBe(64);
    expect(produced.imageSig.length).toBe(64);
    // Wallet verifies the produced stream against the *pinned* key (its half
    // of the contract — the wallet never signs).
    const { manifest, imageHeader } = verifyStream(produced.payload, PINNED_OTA_PUBLIC_KEY);
    expect(manifest.version).toBe('0.9.0');
    expect(manifest.payload_size).toBe(2 * 1024 * 1024);
    expect(imageHeader.payload_len).toBe(2 * 1024 * 1024);

    // The stream frame[0] manifest must carry the image_sig that verified.
    expect(manifest.image_sig.length).toBe(64);
  });

  it('rejects a tampered stream (delivery integrity holds)', async () => {
    const produced = await produceStream(fakeModule(128 * 1024), {});
    const tampered = produced.payload.slice();
    // flip a byte in the middle of the image wrapper payload
    tampered[tampered.length - 300] ^= 0x01;
    expect(() => verifyStream(tampered, PINNED_OTA_PUBLIC_KEY)).toThrow();
  });

  it('round-trips a ~2 MB stream through the BC-UR fountain', async () => {
    const produced = await produceStream(fakeModule(2 * 1024 * 1024), {});
    // encode the minimum fountain parts (+~20% redundancy) like the UI does
    const frames = encodeStreamFrames(produced.payload);
    expect(frames.length).toBeGreaterThan(1);
    // a missing/repeated frame must still reconstruct (fountain property)
    const partial = frames.length > 4 ? frames.slice(0, Math.ceil(frames.length * 0.85)) : frames;
    const decoded = decodeStream(partial);
    expect(decoded).toEqual(produced.payload);
  });

  it('emits a dev stream artifact that a local server can serve', async () => {
    const produced = await produceStream(fakeModule(2 * 1024 * 1024), {
      reqId: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]),
    });
    // sanity: single-part encode of the manifest isn't the artifact, the JSON is
    expect(produced.json.payloadHex).toMatch(/^[0-9a-f]+$/i);
    const dir = path.join(__dirname, 'test-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dev-stream.json'), JSON.stringify(produced.json));
  });
});
