// Mainnet consensus on the real shipped blob, with no network. On mainnet every
// builder binds NU6.3 (Ironwood, 0x37a5165b) from its activation at 3,428,143
// on, at any later height. Since zcli 8cef107 the blob builds on the NU7 branch
// whenever the node reports it (NodeParams), on any network, so on mainnet the
// worker's own guard (branch-ids.ts) is what refuses NU7 before a proof. The note
// fixture is the one in hot-send-wasm.test.ts: the orchard keys do not depend
// on the network, so the same note is owned by the mainnet keys too.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { fixOrchardAddress } from '@repo/wallet/networks/zcash/unified-address';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SpendKeysCtor } from './hot-sign';
import { ironwoodBranchIds, ironwoodBranchRefusal } from './branch-ids';
import {
  planDeposit,
  sendDeposit,
  type DepositChain,
  type DepositWasm,
} from './transparent-deposit';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NU63 = 0x37a5165b;
const NU7 = 0x77190ad9;
const NU63_ACTIVATION = 3_428_143;
/** tx header: version | overwintered, version group id, consensus branch id (LE) */
const V6 = '06000080';
/** a mainnet tex address, paid as its P2PKH twin */
const TEX = 'tex1zclnr35llscdedzrwdmemm70es05ngg9m2d3lv';
const p2pkh = (pubkeyHex: string) =>
  `76a914${bytesToHex(ripemd160(sha256(hexToBytes(pubkeyHex))))}88ac`;
const branchLe = (txHex: string) => txHex.slice(16, 24);
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

interface Wasm extends DepositWasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: SpendKeysCtor;
  build_ironwood_send_pczt(...args: unknown[]): { retained_pczt_hex: string; pczt_hex: string };
  shielding_pool_for_height(height: number, mainnet: boolean): string;
}

describe('mainnet consensus on the real wasm', () => {
  let wasm: Wasm;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
  });

  const ironwoodSend = (target: number, branch: number) => {
    const keys = new wasm.SpendKeys(SEED, 0, true);
    const other = new wasm.SpendKeys(SEED, 9, true);
    try {
      const built = wasm.build_ironwood_send_pczt(
        keys.ufvk(),
        JSON.stringify(NOTES),
        fixOrchardAddress(other.receiving_address(), true),
        600_000n,
        10_000n,
        ANCHOR,
        JSON.stringify(PATHS),
        0,
        target,
        branch,
        true,
        null,
        null,
      );
      return keys.sign_pczt(built.retained_pczt_hex);
    } finally {
      keys.free();
      other.free();
    }
  };

  test.each([NU63_ACTIVATION, 3_506_464, 10_000_000])(
    'an ironwood send at mainnet height %i is V6 bound to NU6.3',
    target => {
      const txHex = ironwoodSend(target, NU63);
      expect(txHex.slice(0, 8)).toBe(V6);
      expect(branchLe(txHex)).toBe('5b16a537');
    },
    300_000,
  );

  test('an ironwood send before NU6.3 is refused; one expecting NU7 follows the node', () => {
    expect(() => ironwoodSend(NU63_ACTIVATION - 1, NU63)).toThrow(/branch/i);
    // the blob trusts the node's NU7 report; the worker guard refuses it on mainnet
    const txHex = ironwoodSend(10_000_000, NU7);
    expect(txHex.slice(0, 8)).toBe(V6);
    expect(branchLe(txHex)).toBe('d90a1977');
  }, 300_000);

  test('a mainnet transparent send binds NU6.3, or NU7 when the node reports it', async () => {
    const keys = new wasm.SpendKeys(SEED, 0, true);
    try {
      const own = p2pkh(keys.transparent_pubkey(0));
      const chain = (tip: number, branch: number): DepositChain => ({
        utxos: () =>
          Promise.resolve([
            {
              txid: new Uint8Array(32).fill(9),
              outputIndex: 0,
              valueZat: 900_000n,
              script: hexToBytes(own),
            },
          ]),
        tip: () => Promise.resolve(tip),
        branchId: () => Promise.resolve(branch),
        broadcast: (txHex: string) => Promise.resolve(txHex.slice(0, 64)),
      });
      const req = { tAddress: 'fake', tIndex: 0, to: TEX, memo: 'zafu', mainnet: true };
      const send = async (tip: number, branch: number) => {
        const plan = await planDeposit(wasm, chain(tip, branch), { ...req, amountZat: '500000' });
        return sendDeposit(wasm, chain(tip, branch), keys, {
          ...req,
          amountZat: '500000',
          reviewedFee: plan.fee,
        });
      };
      for (const tip of [NU63_ACTIVATION - 1, 3_506_464, 10_000_000]) {
        const { txHex } = await send(tip, NU63);
        expect(txHex.slice(0, 8)).toBe('05000080');
        expect(branchLe(txHex)).toBe('5b16a537');
      }
      // NU7 is bound only because the node says so (zcli #26)
      expect(branchLe((await send(10_000_000, NU7)).txHex)).toBe('d90a1977');
      await expect(send(NU63_ACTIVATION - 2, NU63)).rejects.toThrow(/branch id/);
    } finally {
      keys.free();
    }
  });

  test('mainnet shields into ironwood at any height from NU6.3 on', () => {
    for (const h of [NU63_ACTIVATION, 3_506_464, 10_000_000]) {
      expect(wasm.shielding_pool_for_height(h, true)).toBe('ironwood');
    }
  });

  test('the worker refuses NU7 on mainnet before any proof, and takes it on testnet', () => {
    const hex = (id: number) => id.toString(16).padStart(8, '0');
    expect([...ironwoodBranchIds(true)]).toEqual([hex(NU63)]);
    expect(ironwoodBranchRefusal(hex(NU63), true, 'ironwood send')).toBeUndefined();
    expect(ironwoodBranchRefusal(hex(NU7), true, 'ironwood send')).toMatch(
      /0x77190ad9 has no ironwood pool on mainnet .*refusing to build ironwood send/,
    );
    for (const id of [hex(NU63), hex(NU7)]) {
      expect(ironwoodBranchRefusal(id, false, 'turnstile migration')).toBeUndefined();
    }
    // an older upgrade (NU6.1) and the placeholder never carry ironwood
    for (const mainnet of [true, false]) {
      expect(ironwoodBranchRefusal('4dec4df0', mainnet, 'x')).toBeDefined();
      expect(ironwoodBranchRefusal('ffffffff', mainnet, 'x')).toBeDefined();
    }
  });

  test('the worker guard is the only mainnet NU7 gate: the blob builds what the node reports', () => {
    // what the guard lets through on mainnet the blob builds; the NU7 the
    // guard refuses, the blob would bind as the node reported it
    expect(() => ironwoodSend(NU63_ACTIVATION, NU63)).not.toThrow();
    expect(ironwoodBranchRefusal(NU7.toString(16), true, 'ironwood send')).toBeDefined();
    expect(branchLe(ironwoodSend(NU63_ACTIVATION, NU7))).toBe('d90a1977');
  }, 300_000);
});
