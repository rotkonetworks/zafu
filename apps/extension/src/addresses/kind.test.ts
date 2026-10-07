import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { deriveZcashTransparentAddress } from '@repo/wallet/networks/zcash/derive';
import { encodeUnifiedItems, fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import {
  addressKind,
  addressLabel,
  chainOfSwap,
  effectiveNetwork,
  isAddressOn,
  isRealAddress,
  refusalOf,
  zcashAddressOf,
  zcashPayRefusal,
} from './kind';

const UA = 'u1' + 'q'.repeat(100);
const PEN = 'penumbra1' + 'q'.repeat(130);
const ZID = 'ab'.repeat(32);

const BTC_BECH32 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const BTC_TAPROOT = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
const BTC_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const BTC_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const SOL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// a test-only bech32 encoder, so cosmos vectors carry real checksums
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (v: number[]) => {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ x;
    g.forEach((n, i) => ((b >>> i) & 1 ? (c ^= n) : 0));
  }
  return c >>> 0;
};
const toBech32 = (hrp: string, bytes: number[]) => {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits) {
    words.push((acc << (5 - bits)) & 31);
  }
  const hx = [...hrp].map(c => c.charCodeAt(0));
  const pm =
    polymod([...hx.map(c => c >> 5), 0, ...hx.map(c => c & 31), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map(i => (pm >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...check].map(w => CHARSET[w]).join('')}`;
};
const OSMO = toBech32(
  'osmo',
  Array.from({ length: 20 }, (_, i) => i * 7),
);
const flip = (s: string) => s.slice(0, -1) + (s.endsWith('q') ? 'p' : 'q');

describe('addressKind', () => {
  it('tells zcash pools and penumbra apart', () => {
    expect(addressKind(UA)).toEqual({ kind: 'zcash', pool: 'shielded' });
    expect(addressKind('t1' + 'a'.repeat(33))).toEqual({ kind: 'zcash', pool: 'transparent' });
    expect(addressKind('tex1' + 'q'.repeat(38))).toEqual({ kind: 'zcash', pool: 'tex' });
    expect(addressKind(PEN)).toEqual({ kind: 'penumbra' });
  });

  it('knows bitcoin in every form, by its checksum', () => {
    for (const a of [BTC_BECH32, BTC_TAPROOT, BTC_P2PKH, BTC_P2SH, BTC_BECH32.toUpperCase()]) {
      expect(addressKind(a)).toEqual({ kind: 'bitcoin' });
    }
    expect(addressKind(flip(BTC_BECH32)).kind).toBe('unknown');
    expect(addressKind(BTC_P2PKH.replace('Na', 'Nb')).kind).not.toBe('bitcoin');
    // a v0 program checksummed as bech32m, or a taproot one as bech32, is refused
    expect(addressKind(BTC_BECH32.slice(0, 4) + 'x')).toEqual({ kind: 'unknown' });
  });

  it('reads 0x addresses and checks a mixed-case checksum', () => {
    expect(addressKind(ETH)).toEqual({ kind: 'evm' });
    expect(addressKind(ETH.toLowerCase())).toEqual({ kind: 'evm' });
    expect(addressKind(ETH.replace('0x5aA', '0x5aa'))).toEqual({ kind: 'unknown' });
    expect(addressKind('0x1234')).toEqual({ kind: 'unknown' });
  });

  it('reads solana as 32 bytes of base58', () => {
    expect(addressKind(SOL)).toEqual({ kind: 'solana' });
    expect(addressKind('So11111111111111111111111111111111111111112')).toEqual({ kind: 'solana' });
    expect(addressKind(SOL.slice(0, 20)).kind).toBe('unknown');
  });

  it('reads near names, and 64 hex as near only in a near field', () => {
    expect(addressKind('alice.near')).toEqual({ kind: 'near' });
    expect(addressKind('pay.alice-1.near')).toEqual({ kind: 'near' });
    expect(addressKind('Alice.near').kind).toBe('unknown');
    expect(addressKind(ZID)).toEqual({ kind: 'zid' });
    expect(addressKind(ZID, 'near')).toEqual({ kind: 'near' });
    expect(addressKind(ZID, 'bitcoin')).toEqual({ kind: 'zid' });
    expect(isAddressOn(ZID, 'near')).toBe(true);
    expect(isAddressOn(ZID, 'zcash')).toBe(false);
  });

  it('reads cosmos bech32 with a known prefix and a good checksum', () => {
    expect(addressKind(OSMO)).toEqual({ kind: 'cosmos', prefix: 'osmo' });
    expect(addressKind(flip(OSMO)).kind).toBe('unknown');
    // ibc chains come from the registry: an unlisted prefix is still cosmos
    expect(addressKind(toBech32('nope', Array(20).fill(1)))).toEqual({
      kind: 'cosmos',
      prefix: 'nope',
    });
    // but never another chain's bech32, or a payload of the wrong size
    expect(addressKind(toBech32('ltc', Array(20).fill(1))).kind).toBe('unknown');
    expect(addressKind(toBech32('nope', Array(16).fill(1))).kind).toBe('unknown');
  });

  it('never calls a zid or garbage an address', () => {
    for (const s of [ZID, 'hello', '', 'zafu:card?x=1', 'u1bob', '0x', 'bc1']) {
      expect(['zid', 'unknown']).toContain(addressKind(s).kind);
      expect(refusalOf(s)).toBeDefined();
    }
    expect(refusalOf(ZID)).toMatch(/identity, not an address/);
    expect(refusalOf(ZID, 'near')).toBeUndefined();
  });

  it('refuses another chain in a field, calmly', () => {
    expect(refusalOf(ETH, 'bitcoin')).toMatch(/another chain/);
    expect(refusalOf(ETH, 'base')).toBeUndefined();
    expect(refusalOf(BTC_BECH32, 'bitcoin')).toBeUndefined();
    expect(refusalOf('nonsense', 'solana')).toMatch(/solana/);
  });

  it('maps swap chain codes to address chains', () => {
    expect(chainOfSwap('btc')).toBe('bitcoin');
    expect(chainOfSwap('arb')).toBe('arbitrum');
    expect(chainOfSwap('near')).toBe('near');
    expect(chainOfSwap('tron')).toBeUndefined();
  });
});

describe('saved contact addresses', () => {
  it('label each address by its chain', () => {
    expect(addressLabel({ network: 'zcash', address: UA })).toBe('zcash · shielded');
    expect(addressLabel({ network: 'bitcoin', address: BTC_BECH32 })).toBe('bitcoin');
    expect(addressLabel({ network: 'base', address: ETH })).toBe('base');
    expect(addressLabel({ network: 'ethereum', address: ETH })).toBe('ethereum');
    expect(addressLabel({ network: 'cosmos', address: OSMO })).toBe('osmosis');
    expect(addressLabel({ network: 'cosmos', address: toBech32('nope', Array(20).fill(1)) })).toBe(
      'cosmos · nope',
    );
    expect(addressLabel({ network: 'zcash', address: ZID })).toBeUndefined();
  });

  // migration: before 5acc72df everything not "penumbra..." was saved under zcash
  it('show a pre-5acc72df other-chain address under its real chain, never as zcash', () => {
    const old = [
      { id: '1', network: 'zcash' as const, address: BTC_BECH32 },
      { id: '2', network: 'zcash' as const, address: ETH },
      { id: '3', network: 'zcash' as const, address: PEN },
      { id: '4', network: 'zcash' as const, address: ZID },
    ];
    expect(old.map(effectiveNetwork)).toEqual(['bitcoin', 'ethereum', 'penumbra', undefined]);
    expect(old.map(isRealAddress)).toEqual([true, true, true, false]);
    expect(addressLabel(old[0]!)).toBe('bitcoin');
  });

  it('keep a near implicit account saved under near', () => {
    expect(effectiveNetwork({ network: 'near', address: ZID })).toBe('near');
    expect(effectiveNetwork({ network: 'zcash', address: ZID })).toBeUndefined();
  });
});

describe('the zcash send recipient, decoded for real', () => {
  const SEED =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const TEX = 'tex1zclnr35llscdedzrwdmemm70es05ngg9m2d3lv';
  const BAD = "that address doesn't look right · please check it";
  const TESTNET_ON_MAIN = "that's a testnet address · this wallet is on mainnet";
  const MAIN_ON_TESTNET = "that's a mainnet address · this wallet is on testnet";
  let u1 = '';
  let utest1 = '';

  beforeAll(async () => {
    const wasm = (await import('@repo/zcash-wasm')) as unknown as {
      initSync(opts: { module: Uint8Array }): void;
      WalletKeys: new (seed: string) => {
        get_receiving_address(mainnet: boolean): string;
        free(): void;
      };
    };
    // vitest runs from apps/extension
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    const keys = new wasm.WalletKeys(SEED);
    u1 = fixOrchardAddress(keys.get_receiving_address(true), true);
    utest1 = fixOrchardAddress(keys.get_receiving_address(false), false);
    keys.free();
  });

  /** a base58check t-address with these version bytes over a fixed hash */
  const tAddress = (version: [number, number]) => {
    const body = Uint8Array.from([...version, ...new Array<number>(20).fill(7)]);
    const full = Uint8Array.from([...body, ...sha256(sha256(body)).slice(0, 4)]);
    let n = full.reduce((acc, b) => acc * 256n + BigInt(b), 0n);
    let out = '';
    for (; n > 0n; n /= 58n) {
      out = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n % 58n)] + out;
    }
    return out;
  };
  const flipLast = (s: string) => s.slice(0, -1) + (s.endsWith('q') ? 'p' : 'q');
  const t1 = deriveZcashTransparentAddress(SEED, 0, 0, true);
  const tm = deriveZcashTransparentAddress(SEED, 0, 0, false);
  const t3 = tAddress([0x1c, 0xbd]);

  it('pays good u1, t1, t3 and tex addresses on mainnet', () => {
    expect(u1).toMatch(/^u1/);
    expect(t1).toMatch(/^t1/);
    expect(t3).toMatch(/^t3/);
    expect(zcashAddressOf(u1)).toEqual({ pool: 'shielded', mainnet: true });
    expect(zcashAddressOf(t1)).toEqual({ pool: 'transparent', mainnet: true });
    expect(zcashAddressOf(t3)).toEqual({ pool: 'transparent', mainnet: true });
    expect(zcashAddressOf(TEX)).toEqual({ pool: 'tex', mainnet: true });
    for (const a of [u1, t1, t3]) {
      expect(zcashPayRefusal(a, true, false)).toBeUndefined();
    }
  });

  it('refuses a bad checksum, though the prefix looks right', () => {
    for (const a of [flipLast(u1), flipLast(t1), flipLast(t3), flipLast(TEX)]) {
      expect(zcashAddressOf(a)).toBeUndefined();
      expect(zcashPayRefusal(a, true, true)).toBe(BAD);
    }
    expect(zcashPayRefusal('t1' + 'a'.repeat(33), true, false)).toBe(BAD);
    expect(zcashPayRefusal('u1' + 'q'.repeat(100), true, false)).toBe(BAD);
  });

  it('refuses a unified address with no orchard receiver to pay', () => {
    // sapling + p2pkh: well formed, nothing zafu pays
    const noOrchard = encodeUnifiedItems(
      [
        { typecode: 0x00, bytes: new Uint8Array(20).fill(7) },
        { typecode: 0x02, bytes: new Uint8Array(43).fill(9) },
      ],
      'u',
    );
    expect(noOrchard).toMatch(/^u1/);
    expect(zcashPayRefusal(noOrchard, true, false)).toBe(BAD);
  });

  it('a testnet address on mainnet says so', () => {
    expect(utest1).toMatch(/^utest1/);
    expect(tm).toMatch(/^tm/);
    expect(zcashPayRefusal(utest1, true, false)).toBe(TESTNET_ON_MAIN);
    expect(zcashPayRefusal(tm, true, false)).toBe(TESTNET_ON_MAIN);
    expect(zcashPayRefusal(tAddress([0x1c, 0xba]), true, false)).toBe(TESTNET_ON_MAIN);
  });

  it('a mainnet address on testnet says so', () => {
    for (const a of [u1, t1, t3, TEX]) {
      expect(zcashPayRefusal(a, false, true)).toBe(MAIN_ON_TESTNET);
    }
    expect(zcashPayRefusal(utest1, false, false)).toBeUndefined();
    expect(zcashPayRefusal(tm, false, false)).toBeUndefined();
  });

  it('pays a tex address only from transparent funds (ZIP 320)', () => {
    expect(zcashPayRefusal(TEX, true, true)).toBeUndefined();
    expect(zcashPayRefusal(TEX, true, false)).toBe(
      'a tex address takes public zec only · please ask for a u1 or t1 address',
    );
  });
});
