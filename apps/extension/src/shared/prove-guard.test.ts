import { describe, expect, test } from 'vitest';
import { assertProveRequest } from './prove-guard';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOTE = {
  value: 1,
  cmx: 'aa',
  position: 0,
  rseed_hex: '00',
  rho_hex: '01',
  recipient_hex: '',
};

describe('assertProveRequest', () => {
  test('passes a seed-free ironwood send as the worker builds it', () => {
    const req = {
      fn: 'build_ironwood_send_pczt',
      args: [
        'uview1...',
        JSON.stringify([NOTE]),
        'u1...',
        '600000',
        '10000',
        'ab',
        '[]',
        0,
        1,
        2,
        true,
        null,
      ],
    };
    expect(assertProveRequest(req)).toBe(req);
    // rseed_hex is note data, not a seed
    expect(() =>
      assertProveRequest({ fn: 'build_unsigned_pczt', args: ['uview', [NOTE]] }),
    ).not.toThrow();
  });

  test.each([
    'build_signed_spend',
    'build_signed_ironwood_send',
    'build_signed_turnstile_migration',
    'build_shielding',
    'derive_transparent_privkey',
  ])('refuses %s: the prover no longer runs anything that takes a key', fn => {
    expect(() => assertProveRequest({ fn, args: [] })).toThrow(/does not run/);
  });

  test.each([
    ['a bare phrase argument', [PHRASE, 'u1...']],
    ['a phrase nested in an object', [{ deep: [PHRASE] }]],
    ['a mnemonic field', [{ mnemonic: 'x' }]],
    ['a seed field', [{ seed: 'x' }]],
    ['a privkey field', [{ privkeyHex: '00' }]],
    ['a vault', [{ vault: { box: '{}' } }]],
  ])('refuses %s', (_, args) => {
    expect(() => assertProveRequest({ fn: 'build_unsigned_pczt', args })).toThrow(/key material/);
  });

  test('refuses a CryptoKey', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'decrypt',
    ]);
    expect(() => assertProveRequest({ fn: 'build_unsigned_pczt', args: [key] })).toThrow(
      /key material/,
    );
  });

  test('refuses anything that is not a prove request', () => {
    expect(() => assertProveRequest(null)).toThrow();
    expect(() => assertProveRequest({ fn: 'build_unsigned_pczt' })).toThrow();
  });
});
