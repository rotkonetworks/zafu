// The check send-tx-pczt-complete makes before broadcasting a signer's whole
// PCZT, on the real shipped blob: the ZIP-244 sighash frost_inspect_pczt_outputs
// recomputes is the same for the PCZT zafu keeps and the redacted copy the
// device gets, and differs for any other transaction. Fixture as in
// mainnet-consensus-wasm.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import type { SpendKeysCtor } from './hot-sign';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOTES = [
  {
    value: 1_000_000,
    nullifier: '18ccfc57455447dc8bb45ba80d6e4f511a9fcc9af87f8b4bb6bf21a6cfe1ca3d',
    cmx: 'd67408aa1dd5273d13662b1d64be43ed87c410d957cf6f64bc9ca4f72b777b2d',
    position: 0,
    rseed_hex: '00'.repeat(32),
    rho_hex: '01'.repeat(32),
    recipient_hex:
      '82911d92fb24edeaa7220057cdf4db32a0006bfd1a8af4bd27ad8fd2bb5a2f4369313457ec7f3a22b4c10b',
  },
];
const PATHS = [{ path: Array<string>(32).fill('00'.repeat(32)), position: 0 }];
const ANCHOR = '1c599139a3f69be978c96691b046b407169540f5a6ccacf043642a9c1144b205';
const NU63 = 0x37a5165b;
const HEIGHT = 3_506_464;

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: SpendKeysCtor;
  build_ironwood_send_pczt(...args: unknown[]): { retained_pczt_hex: string; pczt_hex: string };
  frost_inspect_pczt_outputs(pczt_hex: string, ufvk: string): string;
}

describe('a whole signed PCZT is checked against the reviewed build', () => {
  let wasm: Wasm;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
  });

  const build = (amount: bigint) => {
    const keys = new wasm.SpendKeys(SEED, 0, true);
    const other = new wasm.SpendKeys(SEED, 9, true);
    try {
      const ufvk = keys.ufvk();
      const built = wasm.build_ironwood_send_pczt(
        ufvk,
        JSON.stringify(NOTES),
        fixOrchardAddress(other.receiving_address(), true),
        amount,
        10_000n,
        ANCHOR,
        JSON.stringify(PATHS),
        0,
        HEIGHT,
        NU63,
        true,
        null,
        null,
      );
      return { ufvk, ...built };
    } finally {
      keys.free();
      other.free();
    }
  };
  const sighash = (pczt: string, ufvk: string) =>
    (JSON.parse(wasm.frost_inspect_pczt_outputs(pczt, ufvk)) as { computed_sighash_hex: string })
      .computed_sighash_hex;

  test('the device copy is the reviewed transaction; another one is not', () => {
    const a = build(600_000n);
    const kept = sighash(a.retained_pczt_hex, a.ufvk);
    expect(kept).toMatch(/^[0-9a-f]{64}$/);
    expect(sighash(a.pczt_hex, a.ufvk)).toBe(kept);
    const b = build(500_000n);
    expect(sighash(b.retained_pczt_hex, b.ufvk)).not.toBe(kept);
  }, 300_000);
});
