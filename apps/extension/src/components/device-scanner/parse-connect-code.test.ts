import { describe, it, expect } from 'vitest';
import { parseConnectCode, parseConnectCodeBytes } from './parse-connect-code';

// ── fixture builders, from the documented wire formats in
// packages/wallet/src/{zigner-signer,zcash-zigner}.ts (legacy binary QR) and
// ur-parser.ts (zcash-accounts CBOR map) - not invented, just hand-assembled
// bytes for the documented shape. ──

function toHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

/** legacy zigner penumbra FVK export QR (see zigner-signer.ts parseZignerFvkQR) */
function penumbraLegacyHex(): string {
  const label = 'cold keys';
  const labelBytes = Array.from(new TextEncoder().encode(label));
  return toHex([
    0x53,
    0x03,
    0x01,
    ...u32le(0),
    labelBytes.length,
    ...labelBytes,
    ...new Array(64).fill(0xab), // fvk: ak || nk
    ...new Array(32).fill(0xcd), // wallet_id
  ]);
}

/** legacy zigner zcash FVK export QR (see zcash-zigner.ts parseZcashFvkQR) */
function zcashLegacyHex(): string {
  const label = 'zigner zcash';
  const labelBytes = Array.from(new TextEncoder().encode(label));
  const flags = 0b0000_0011; // mainnet + has orchard, no transparent
  return toHex([
    0x53,
    0x04,
    0x01,
    flags,
    ...u32le(0),
    labelBytes.length,
    ...labelBytes,
    ...new Array(96).fill(0xef), // orchard fvk
  ]);
}

// ── minimal hand-rolled CBOR encoder, just enough for the zcash-accounts
// map shape parseZcashAccountsCbor expects (map(2): {1: bytes(16), 2: [map]})

function cborUint(n: number): number[] {
  if (n < 24) {
    return [n];
  }
  if (n < 256) {
    return [0x18, n];
  }
  throw new Error('fixture uint too large');
}
function cborLenPrefix(majorByte: number, len: number): number[] {
  if (len < 24) {
    return [majorByte | len];
  }
  if (len < 256) {
    return [majorByte | 24, len];
  }
  return [majorByte | 25, (len >> 8) & 0xff, len & 0xff];
}
function cborBytes(bytes: number[]): number[] {
  return [...cborLenPrefix(0x40, bytes.length), ...bytes];
}
function cborText(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...cborLenPrefix(0x60, bytes.length), ...bytes];
}

/** a `zcash-accounts` CBOR map: {1: seed_fingerprint(16), 2: [{1: ufvk, 2: 0, 3: name[, 4: zid]}]} */
function zcashAccountsCbor(opts: { ufvk: string; name: string; zidHex?: string }): Uint8Array {
  const zidField = opts.zidHex
    ? [...cborUint(4), ...cborBytes(Array.from(Buffer.from(opts.zidHex, 'hex')))]
    : [];
  const account = [
    0xa0 | (3 + (opts.zidHex ? 1 : 0)), // map(3 or 4)
    ...cborUint(1),
    ...cborText(opts.ufvk),
    ...cborUint(2),
    ...cborUint(0),
    ...cborUint(3),
    ...cborText(opts.name),
    ...zidField,
  ];
  const bytes = [
    0xa2, // map(2)
    ...cborUint(1),
    ...cborBytes(new Array(16).fill(0x11)),
    ...cborUint(2),
    0x81, // array(1)
    ...account,
  ];
  return new Uint8Array(bytes);
}

const REAL_UFVK = 'uview1' + 'q'.repeat(250);

describe('parseConnectCode', () => {
  it('reads a real penumbra FVK export (legacy binary QR) - always a zigner', () => {
    const result = parseConnectCode(penumbraLegacyHex());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.network).toBe('penumbra');
    expect(result.device).toBe('zigner');
    expect(result.accountIndex).toBe(0);
  });

  it('reads a real zcash FVK export (legacy binary QR)', () => {
    const result = parseConnectCode(zcashLegacyHex());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.network).toBe('zcash');
    expect(result.mainnet).toBe(true);
    expect(result.orchardFvk).not.toBeNull();
  });

  it('declines a substrate connect code calmly (polkadot is gone)', () => {
    const result = parseConnectCode('substrate:5F...someaddress:0xdeadbeef');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('garbage');
    expect(result.message).not.toMatch(/!/);
  });

  it('declines a cosmos-accounts json code calmly (zigner scope is zcash + penumbra)', () => {
    const result = parseConnectCode(
      JSON.stringify({
        type: 'cosmos-accounts',
        addresses: [{ chain_id: 'noble', address: 'noble1x', prefix: 'noble' }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('garbage');
  });

  it('refuses garbage', () => {
    const result = parseConnectCode('not a connect code at all');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('garbage');
  });

  it('refuses an empty paste', () => {
    const result = parseConnectCode('   ');
    expect(result.ok).toBe(false);
  });

  it('names a signing request instead of silently refusing it', () => {
    // a zcash-pczt UR is a different flow (sign), not a connect code
    const result = parseConnectCode('ur:zcash-pczt/1-1/data');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('signing-request');
  });
});

describe('parseConnectCodeBytes (keystone / multi-frame path)', () => {
  it('classifies a keystone zcash-accounts payload (no zid) as keystone', () => {
    const cbor = zcashAccountsCbor({ ufvk: REAL_UFVK, name: 'keystone zcash' });
    const result = parseConnectCodeBytes(cbor);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.network).toBe('zcash');
    expect(result.device).toBe('keystone');
    expect(result.ufvk).toBe(REAL_UFVK);
    expect(result.zidPublicKey).toBeUndefined();
  });

  it('classifies a zigner zcash-accounts payload (zid present) as zigner', () => {
    const cbor = zcashAccountsCbor({
      ufvk: REAL_UFVK,
      name: 'zigner zcash',
      zidHex: 'ab'.repeat(32),
    });
    const result = parseConnectCodeBytes(cbor);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.device).toBe('zigner');
    expect(result.zidPublicKey).toBe('ab'.repeat(32));
  });

  it('refuses malformed cbor', () => {
    const result = parseConnectCodeBytes(new Uint8Array([0xff, 0xff]));
    expect(result.ok).toBe(false);
  });
});
