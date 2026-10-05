/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { BUNDLED_SERVICE_CONFIG, BUNDLED_STATIC_CONFIG } from './bundled-config';
import { endorsedEaPkHex } from './round-auth';

const hex = (b64: string) => Buffer.from(b64, 'base64').toString('hex');
const rounds = Object.entries(BUNDLED_SERVICE_CONFIG.rounds);

describe('endorsedEaPkHex', () => {
  test('every bundled auth_version 2 prod round verifies under the bundled trusted keys', () => {
    const v2 = rounds.filter(([, e]) => e.auth_version === 2);
    expect(v2.length).toBeGreaterThan(5);
    for (const [id, entry] of v2) {
      expect(endorsedEaPkHex(BUNDLED_STATIC_CONFIG, BUNDLED_SERVICE_CONFIG, id)).toBe(
        hex(entry.ea_pk),
      );
    }
  });

  test('a legacy auth_version 1 entry (signature over the bare ea_pk) is not accepted', () => {
    const v1 = rounds.filter(([, e]) => e.auth_version === 1);
    expect(v1.length).toBeGreaterThan(0);
    for (const [id] of v1) {
      expect(endorsedEaPkHex(BUNDLED_STATIC_CONFIG, BUNDLED_SERVICE_CONFIG, id)).toBeUndefined();
    }
  });

  test('a signed ea_pk does not carry over to another round id', () => {
    const [id, entry] = rounds.find(([, e]) => e.auth_version === 2)!;
    const other = id.replace(/^./, c => (c === '0' ? '1' : '0'));
    const config = { ...BUNDLED_SERVICE_CONFIG, rounds: { [other]: entry } };
    expect(endorsedEaPkHex(BUNDLED_STATIC_CONFIG, config, other)).toBeUndefined();
  });

  test('a swapped ea_pk, an unknown signer or a changed PIR layout is refused', () => {
    const [id, entry] = rounds.find(([, e]) => e.auth_version === 2)!;
    const swapped = { ...entry, ea_pk: Buffer.alloc(32, 7).toString('base64') };
    expect(
      endorsedEaPkHex(
        BUNDLED_STATIC_CONFIG,
        { ...BUNDLED_SERVICE_CONFIG, rounds: { [id]: swapped } },
        id,
      ),
    ).toBeUndefined();
    expect(
      endorsedEaPkHex({ ...BUNDLED_STATIC_CONFIG, trusted_keys: [] }, BUNDLED_SERVICE_CONFIG, id),
    ).toBeUndefined();
    const layout = { ...BUNDLED_SERVICE_CONFIG.pir_layout!, poly_len: 2048 };
    expect(
      endorsedEaPkHex(BUNDLED_STATIC_CONFIG, { ...BUNDLED_SERVICE_CONFIG, pir_layout: layout }, id),
    ).toBeUndefined();
  });

  test('a round missing from the bundled config has no endorsed key', () => {
    expect(
      endorsedEaPkHex(BUNDLED_STATIC_CONFIG, BUNDLED_SERVICE_CONFIG, 'ab'.repeat(32)),
    ).toBeUndefined();
  });
});
