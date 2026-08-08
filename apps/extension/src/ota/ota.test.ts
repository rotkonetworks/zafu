import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  encodeMap,
  decodeStrict,
  decodeCanonical,
  OtaCborError,
} from './canonical';
import type { CborValue } from './canonical';
import { compareSemver, parseSemver, isValidSemver } from './semver';
import { verifyManifest, verifyImage, verifyResult, verifyStatus, assertValidPinnedKey, signedMessageHex } from './signature';
import {
  encodeStreamFrames,
  decodeStream,
  encodeSinglePart,
  decodeSinglePart,
  STREAM_UR_TYPE,
  RESULT_UR_TYPE,
  buildStreamPayload,
} from './ur';
import { verifyStream, OtaStreamError } from './stream';
import { BOARD, KEY_ID_BLACKLIST, CLASS_WHITELIST, PINNED_OTA_PUBLIC_KEY, MAX_STREAM_BYTES } from './keys';
import { toHex, hexToBytes, bytesEqual } from './util';

const CORPUS_PATH = path.resolve(process.cwd(), 'src/ota/test-data/test-vectors.json');
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf-8'));

function bytes(s: string): Uint8Array {
  return hexToBytes(s);
}

/** Build the full wire manifest map (fields 1..9) from a corpus vector. */
function fullManifestMap(v: Record<string, unknown>, reqIdHex = v.req_id_hex as string): [number, CborValue][] {
  return [
    [1, v.version as string],
    [2, corpus.board as string],
    [3, hexToBytes(v.payload_sha256_hex as string)],
    [4, v.payload_size as number],
    [5, v.min_version as string],
    [6, v.key_id as number],
    [7, v.class as string],
    [8, hexToBytes(v.image_sig_hex as string)],
    [9, hexToBytes(reqIdHex)],
  ];
}

/** Build the full stream payload (full manifest || image wrapper). */
function buildStreamPayloadFor(v: Record<string, unknown>): Uint8Array {
  const manifestFull = encodeMap(fullManifestMap(v));
  const imageWrapper = hexToBytes(v.image_wrapper_hex as string);
  return buildStreamPayload(manifestFull, imageWrapper);
}

describe('(a) canonical reproduction of the golden corpus', () => {
  it('reproduces manifest canonical byte-for-byte', () => {
    for (const name of ['release_0_9_0', 'rollback_0_8_5']) {
      const v = corpus.vectors[name];
      const m: [number, CborValue][] = [
        [1, v.version],
        [2, corpus.board],
        [3, hexToBytes(v.payload_sha256_hex)],
        [4, v.payload_size],
        [5, v.min_version],
        [6, v.key_id],
        [7, v.class],
      ];
      expect(toHex(encodeMap(m))).toBe(v.manifest_canonical_hex);
      // strict decode round-trips
      expect(decodeStrict(hexToBytes(v.manifest_canonical_hex))).toBeInstanceOf(Map);
    }
  });

  it('reproduces image canonical byte-for-byte', () => {
    for (const name of ['release_0_9_0', 'rollback_0_8_5']) {
      const v = corpus.vectors[name];
      const m: [number, CborValue][] = [
        [1, v.key_id],
        [2, corpus.board],
        [3, v.version],
        [4, hexToBytes(v.payload_sha256_hex)],
        [5, v.payload_size],
      ];
      expect(toHex(encodeMap(m))).toBe(v.image_canonical_hex);
    }
  });

  it('reproduces result + status canonical byte-for-byte', () => {
    const r = corpus.vectors.result_success_B;
    const rm: [number, CborValue][] = [
      [1, r.fw_version],
      [2, r.success],
      [3, r.slot],
      [4, hexToBytes(r.req_id_hex)],
      [5, hexToBytes(r.zid_pubkey_hex)],
    ];
    expect(toHex(encodeMap(rm))).toBe(r.canonical_hex);

    const s = corpus.vectors.status;
    const sm: [number, CborValue][] = [
      [1, s.fw_version],
      [2, s.slot],
      [3, s.successful_boot],
      [4, hexToBytes(s.zid_pubkey_hex)],
    ];
    expect(toHex(encodeMap(sm))).toBe(s.canonical_hex);
  });

  it('reproduces the signed (domained) forms exactly', () => {
    const rel = corpus.vectors.release_0_9_0;
    expect(signedMessageHex('manifest', rel.manifest_canonical_hex)).toBe(rel.manifest_signed_hex);
    expect(signedMessageHex('image', rel.image_canonical_hex)).toBe(rel.image_signed_hex);
    const r = corpus.vectors.result_success_B;
    expect(signedMessageHex('result', r.canonical_hex)).toBe(r.signed_hex);
    const s = corpus.vectors.status;
    expect(signedMessageHex('status', s.canonical_hex)).toBe(s.signed_hex);
  });

  it('rejects trailing bytes / dup keys / non-minimal ints / indefinite', () => {
    const rel = corpus.vectors.release_0_9_0;
    const good = hexToBytes(rel.manifest_canonical_hex);
    // trailing byte
    const trailing = new Uint8Array([...good, 0x00]);
    expect(() => decodeStrict(trailing)).toThrow(OtaCborError);
    // duplicate key (a9 with two key 1 entries) not submittable via our encoder, so
    // craft: map2 {1:0,1:1} encoded manually: a2 01 00 01 01
    expect(() => decodeStrict(hexToBytes('a201000101'))).toThrow(OtaCborError);
    // non-minimal int: 0x1800 encodes 0 with 1 byte -> 0 must be 0x00
    expect(() => decodeStrict(hexToBytes('1800'))).toThrow(OtaCborError);
    // indefinite map marker
    expect(() => decodeStrict(hexToBytes('bf'))).toThrow(OtaCborError);
    // indefinite tstr
    expect(() => decodeStrict(hexToBytes('7f'))).toThrow(OtaCborError);
  });
});

describe('(b) positive signature verification against corpus pubkeys', () => {
  const pub = hexToBytes(corpus.ota_sign_public_key_hex);
  const zid = hexToBytes(corpus.device_zid_public_key_hex);

  it('verifies manifest_sig and image_sig for release + rollback', () => {
    for (const name of ['release_0_9_0', 'rollback_0_8_5']) {
      const v = corpus.vectors[name];
      expect(verifyManifest(v.manifest_canonical_hex, pub, v.manifest_sig_hex)).toBe(true);
      expect(verifyImage(v.image_canonical_hex, pub, v.image_sig_hex)).toBe(true);
    }
  });

  it('verifies result_sig and status_sig against zid_pubkey', () => {
    const r = corpus.vectors.result_success_B;
    expect(verifyResult(r.canonical_hex, zid, r.result_sig_hex)).toBe(true);
    const s = corpus.vectors.status;
    expect(verifyStatus(s.canonical_hex, zid, s.status_sig_hex)).toBe(true);
  });
});

describe('(c) rejects tampered signature and wrong key', () => {
  const pub = hexToBytes(corpus.ota_sign_public_key_hex);
  const v = corpus.vectors.release_0_9_0;
  const goodSig = hexToBytes(v.manifest_sig_hex);

  it('rejects a tampered signature', () => {
    const tampered = goodSig.slice();
    tampered[0] = tampered[0]! ^ 0xff;
    expect(verifyManifest(v.manifest_canonical_hex, pub, tampered)).toBe(false);
  });

  it('rejects a wrong key', () => {
    // a valid but different ed25519 pubkey
    const wrongKey = hexToBytes(
      'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    );
    expect(verifyManifest(v.manifest_canonical_hex, wrongKey, v.manifest_sig_hex)).toBe(false);
  });

  it('rejects identity / small-order public key at pin', () => {
    expect(() => assertValidPinnedKey(new Uint8Array(32))).toThrow();
  });
});

describe('(d) semver ordering matrix', () => {
  it('numeric component-wise compare', () => {
    expect(compareSemver('0.9.0', '0.8.5')).toBe(1);
    expect(compareSemver('0.8.5', '0.9.0')).toBe(-1);
    expect(compareSemver('0.9.0', '0.9.0')).toBe(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1); // numeric, not lexicographic
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
  });

  it('rejects v prefix / prerelease / build / partial', () => {
    expect(compareSemver('v0.9.0', '0.9.0')).toBeNull();
    expect(compareSemver('0.9.0-beta.1', '0.9.0')).toBeNull();
    expect(compareSemver('0.9.0+build.5', '0.9.0')).toBeNull();
    expect(compareSemver('0.9', '0.8.0')).toBeNull();
    expect(compareSemver('0.9.0.1', '0.9.0')).toBeNull();
    expect(compareSemver('', '0.9.0')).toBeNull();
    expect(isValidSemver('0.9.0')).toBe(true);
    expect(isValidSemver('v1.0.0')).toBe(false);
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
});

describe('(e) ur stream encode/decode round-trip', () => {
  it('round-trips the full signed stream payload through the fountain', () => {
    const v = corpus.vectors.release_0_9_0;
    const payload = buildStreamPayloadFor(v);
    const frames = encodeStreamFrames(payload, 400);
    expect(frames.length).toBeGreaterThan(0);
    const rebuilt = decodeStream(frames);
    expect(bytesEqual(rebuilt, payload)).toBe(true);
  });

  it('round-trips a small result/status single-part UR', () => {
    const r = corpus.vectors.result_success_B;
    const canonical = hexToBytes(r.canonical_hex);
    const uri = encodeSinglePart(RESULT_UR_TYPE, canonical);
    expect(uri.startsWith('ur:zafu-result/')).toBe(true);
    const decoded = decodeSinglePart(uri);
    expect(decoded.type).toBe(RESULT_UR_TYPE);
    expect(bytesEqual(decoded.bytes, canonical)).toBe(true);
  });
});

describe('(f) verifyStream policy rejections', () => {
  const pub = hexToBytes(corpus.ota_sign_public_key_hex);
  const good = buildStreamPayloadFor(corpus.vectors.release_0_9_0);

  it('accepts a well-formed verified stream', () => {
    const { manifest, imageHeader, imagePresent } = verifyStream(good, pub);
    expect(manifest.version).toBe('0.9.0');
    expect(manifest.board).toBe(corpus.board);
    expect(manifest.class).toBe('release');
    expect(imageHeader.payload_len).toBe(672);
    expect(imagePresent).toBe(true);
  });

  it('rejects a blacklisted key_id', () => {
    KEY_ID_BLACKLIST.push(corpus.vectors.release_0_9_0.key_id);
    try {
      expect(() => verifyStream(good, pub)).toThrow(OtaStreamError);
    } finally {
      KEY_ID_BLACKLIST.pop();
    }
  });

  it('rejects a wrong board', () => {
    const v = corpus.vectors.release_0_9_0;
    const m: [number, CborValue][] = fullManifestMap(v);
    m[1] = [2, 'zigner-ios'];
    const payload = buildStreamPayload(encodeMap(m), hexToBytes(v.image_wrapper_hex));
    expect(() => verifyStream(payload, pub)).toThrow(/board/);
  });

  it('rejects an unknown class', () => {
    const v = corpus.vectors.release_0_9_0;
    const m = fullManifestMap(v);
    m[6] = [7, 'experimental']; // field index 6 in the array = key 7 (class)
    const payload = buildStreamPayload(encodeMap(m), hexToBytes(v.image_wrapper_hex));
    expect(() => verifyStream(payload, pub)).toThrow(/class/);
  });

  it('rejects a downgrade (version < min_version) and an invalid version', () => {
    const v = corpus.vectors.release_0_9_0;
    // version field (key 1) below min
    const m1 = fullManifestMap(v);
    m1[0] = [1, '0.7.5'];
    expect(() => verifyStream(buildStreamPayload(encodeMap(m1), hexToBytes(v.image_wrapper_hex)), pub)).toThrow(/min_version|downgrade|semver/);
    // invalid semver (v prefix)
    const m2 = fullManifestMap(v);
    m2[0] = [1, 'v0.9.0'];
    expect(() => verifyStream(buildStreamPayload(encodeMap(m2), hexToBytes(v.image_wrapper_hex)), pub)).toThrow(/semver/);
  });

  it('rejects a tampered image_sig', () => {
    const v = corpus.vectors.release_0_9_0;
    const m = fullManifestMap(v);
    const badSig = hexToBytes(v.image_sig_hex).slice();
    badSig[0] = badSig[0]! ^ 0x01;
    m[7] = [8, badSig];
    const payload = buildStreamPayload(encodeMap(m), hexToBytes(v.image_wrapper_hex));
    expect(() => verifyStream(payload, pub)).toThrow(/image_sig/);
  });

  it('rejects a wrong pinned key (server MITM / wrong signer)', () => {
    const wrong = hexToBytes(
      'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    );
    expect(() => verifyStream(good, wrong)).toThrow(/image_sig|sig/);
  });

  it('rejects an oversized stream (> cap)', () => {
    const big = new Uint8Array(MAX_STREAM_BYTES + 1);
    expect(() => verifyStream(big, pub)).toThrow(/too large/);
  });
});
