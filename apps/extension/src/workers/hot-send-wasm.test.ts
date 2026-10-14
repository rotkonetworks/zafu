// The hot send seam end to end on the real shipped blob, with no network: the
// prover side (build_ironwood_send_pczt from the UFVK SpendKeys hands out, as
// the offscreen document runs it) and the worker side (SpendKeys.sign_pczt).
// sign_pczt returns only after the pczt extractor has verified the proof and
// every spend-auth and binding signature against the sighash. It proves
// single-threaded, about ten seconds. The fixture (one V3 note of the test seed's testnet account 0, a single-leaf
// path and its anchor) is printed by zcli's
//   cargo test --release --test hot_sign_split print_wasm_send_fixture -- --ignored --nocapture
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import { assertProveRequest } from '../shared/prove-guard';
import { planIronwoodMultiSend } from './ironwood-multi-send';
import type { SpendKeysCtor } from './hot-sign';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// testnet heights: NU6.3 is active from 4,134,000, NU7 from 4,465,026; both have ironwood
const UPGRADES = [
  { name: 'NU6.3', target: 4_300_000, branchId: 0x37a5165b },
  { name: 'NU7', target: 4_466_000, branchId: 0x77190ad9 },
];
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

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: SpendKeysCtor;
  build_ironwood_send_pczt(...args: unknown[]): { retained_pczt_hex: string; pczt_hex: string };
  build_ironwood_send_pczt_multi(...args: unknown[]): {
    retained_pczt_hex: string;
    pczt_hex: string;
    summary: { ironwood_actions: number; outputs: [string, number][]; fee_zat: number };
  };
  compute_txid(txHex: string): string;
  WalletKeys: {
    from_seed_phrase_account(
      seed: string,
      account: number,
    ): {
      decrypt_transaction_memos(tx: Uint8Array): {
        value: number;
        memo: string;
        is_outgoing: boolean;
      }[];
      free(): void;
    };
  };
}

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(b => parseInt(b, 16)));

describe('hot ironwood send on the real wasm', () => {
  let wasm: Wasm;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
  });

  test.each(UPGRADES)(
    '$name: proves from the UFVK, signs in the worker, and the tx verifies',
    ({ target, branchId }) => {
      const keys = new wasm.SpendKeys(SEED, 0, false);
      const other = new wasm.SpendKeys(SEED, 9, false);
      try {
        const args = [
          keys.ufvk(),
          JSON.stringify(NOTES),
          fixOrchardAddress(other.receiving_address(), false),
          600_000n,
          10_000n,
          ANCHOR,
          JSON.stringify(PATHS),
          0,
          target,
          branchId,
          false,
          null,
          null,
        ];
        // exactly what may cross the prover relay
        assertProveRequest({ fn: 'build_ironwood_send_pczt', args: args.map(String) });
        expect(JSON.stringify(args.map(String))).not.toContain('abandon');

        const built = wasm.build_ironwood_send_pczt(...args);
        const txHex = keys.sign_pczt(built.retained_pczt_hex);
        // V6 header (version 6 | overwintered) and a txid the node would index
        expect(txHex.slice(0, 8)).toBe('06000080');
        expect(wasm.compute_txid(txHex)).toMatch(/^[0-9a-f]{64}$/);
        // the redacted copy signs to a valid tx too (the cold builders' output)
        expect(keys.sign_pczt(built.pczt_hex).slice(0, 8)).toBe('06000080');
        // another pocket's keys sign nothing
        expect(() => other.sign_pczt(built.retained_pczt_hex)).toThrow(/another account/);
      } finally {
        keys.free();
        other.free();
      }
    },
    300_000,
  );

  test.each(UPGRADES)(
    '$name: several outputs, one tx - each recipient gets its amount and memo',
    ({ target, branchId }) => {
      const keys = new wasm.SpendKeys(SEED, 0, false);
      const seat = new wasm.SpendKeys(SEED, 9, false);
      const rake = new wasm.SpendKeys(SEED, 8, false);
      try {
        const outputs = planIronwoodMultiSend(
          [
            {
              address: fixOrchardAddress(seat.receiving_address(), false),
              amount: '300000',
              memo: 'seat deposit',
            },
            {
              address: fixOrchardAddress(rake.receiving_address(), false),
              amount: '200000',
              memo: 'rake',
            },
          ],
          () => false,
        ).outputs;
        // 1 spend, 2 outputs + change: 3 ironwood actions under ZIP-317
        const fee = 15_000n;
        const args = [
          keys.ufvk(),
          JSON.stringify(NOTES),
          JSON.stringify(outputs),
          fee,
          ANCHOR,
          JSON.stringify(PATHS),
          0,
          target,
          branchId,
          false,
          null,
        ];
        assertProveRequest({ fn: 'build_ironwood_send_pczt_multi', args: args.map(String) });

        const built = wasm.build_ironwood_send_pczt_multi(...args);
        expect(built.summary.ironwood_actions).toBe(3);
        expect(built.summary.fee_zat).toBe(15_000);
        const txHex = keys.sign_pczt(built.retained_pczt_hex);
        expect(txHex.slice(0, 8)).toBe('06000080');
        expect(wasm.compute_txid(txHex)).toMatch(/^[0-9a-f]{64}$/);

        const received = (account: number) => {
          const wk = wasm.WalletKeys.from_seed_phrase_account(SEED, account);
          try {
            return wk.decrypt_transaction_memos(hexBytes(txHex));
          } finally {
            wk.free();
          }
        };
        expect(received(9)).toEqual([
          expect.objectContaining({ value: 300_000, memo: 'seat deposit', is_outgoing: false }),
        ]);
        expect(received(8)).toEqual([
          expect.objectContaining({ value: 200_000, memo: 'rake', is_outgoing: false }),
        ]);
        // the change: 1,000,000 - 500,000 - 15,000
        expect(received(0)).toEqual([
          expect.objectContaining({ value: 485_000, is_outgoing: true }),
        ]);
      } finally {
        keys.free();
        seat.free();
        rake.free();
      }
    },
    300_000,
  );
});
