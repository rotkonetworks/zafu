// The thorchain deposit path on the real shipped blob, with no network: plan
// from UTXOs with no key, build from the pubkey, sign with SpendKeys, check the
// signed bytes, broadcast. The regtest fixture is the deposit zcli's
// regtest_transparent_op_return mined on zebrad 6.2.3 regtest.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SpendKeysCtor } from './hot-sign';
import {
  checkDeposit,
  FEE_MOVED,
  opReturnScript,
  planDeposit,
  sendDeposit,
  transparentOutputs,
  type DepositChain,
  type DepositWasm,
} from './transparent-deposit';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MEMO = '=:ETH.USDC:0xf3e03d4905725065Cc2E342Fc56BD1769A29E322:0/1/0:zafu:50';
const MEMO_HEX = bytesToHex(new TextEncoder().encode(MEMO));
/** testnet P2PKH of hash160 0x42 * 20 */
const VAULT = 'tmFkhJaNXuoMeKKBHp8EE9oiFW4uXKAPWnH';
const VAULT_SCRIPT = `76a914${'42'.repeat(20)}88ac`;

const MINED =
  '050000800a27a7265b16a53700000000940000000182f9f46254f963a367bccadca55c224b8d8fdccc2009d256b5b5c6bc7d4571b9000000006b483045022100a2857a7f93ced4cedda0b6a5ee98b1a9694451b403cb881fc68c04f3ecd9a57602202a19591d101d6932b34f4367f12785664793234b2971f604a584ff2d7762ee33012102552c630b64b54bf50210c9e253d38bd4949c72e22873500f6285c2bede312a84ffffffff03466b3506000000001976a9144e2be896e0f48daa6fa6f7b644750fda930fffdb88ac0000000000000000456a433d3a4554482e555344433a3078663365303364343930353732353036354363324533343246633536424431373639413239453332323a302f312f303a7a6166753a3530e6746a0c000000001976a914db3f00d429f2715383cc594258ec11d6de52669788ac000000';

const p2pkh = (pubkeyHex: string) =>
  `76a914${bytesToHex(ripemd160(sha256(hexToBytes(pubkeyHex))))}88ac`;

describe('deposit bytes', () => {
  test('op_return pushes up to 75 bytes directly, then with OP_PUSHDATA1', () => {
    expect(opReturnScript(MEMO_HEX)).toBe(`6a43${MEMO_HEX}`);
    expect(opReturnScript('6d'.repeat(80))).toBe(`6a4c50${'6d'.repeat(80)}`);
  });

  test('the regtest deposit reads as [vault, memo, change to the funder]', () => {
    const outs = transparentOutputs(MINED);
    expect(outs.map(o => o.value)).toEqual([104164166n, 0n, 208303334n]);
    expect(outs[1]!.script).toBe(opReturnScript(MEMO_HEX));
    const want = {
      toScript: '76a9144e2be896e0f48daa6fa6f7b644750fda930fffdb88ac',
      amountZat: 104164166n,
      memoHex: MEMO_HEX,
      ownScript: '76a914db3f00d429f2715383cc594258ec11d6de52669788ac',
    };
    expect(() => checkDeposit(MINED, want)).not.toThrow();
    expect(() => checkDeposit(MINED, { ...want, amountZat: 1n })).toThrow(/does not match/);
    expect(() => checkDeposit(MINED, { ...want, toScript: VAULT_SCRIPT })).toThrow(
      /does not match/,
    );
    expect(() => checkDeposit(MINED, { ...want, memoHex: '00' })).toThrow(/does not match/);
    expect(() => checkDeposit(MINED, { ...want, ownScript: VAULT_SCRIPT })).toThrow(
      /does not match/,
    );
  });
});

interface Wasm extends DepositWasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: SpendKeysCtor;
}

describe('deposit on the real wasm', () => {
  let wasm: Wasm;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
  });

  const chainWith = (script: string, values: bigint[]) => {
    const broadcast = vi.fn((txHex: string) => Promise.resolve(txHex.slice(0, 64)));
    const chain: DepositChain = {
      utxos: () =>
        Promise.resolve(
          values.map((valueZat, i) => ({
            txid: new Uint8Array(32).fill(i + 1),
            outputIndex: 0,
            valueZat,
            script: hexToBytes(script),
          })),
        ),
      tip: () => Promise.resolve(10_000_000),
      branchId: () => Promise.resolve(0x37a5165b),
      broadcast,
    };
    return { chain, broadcast };
  };

  const req = { tAddress: 'unused-by-the-fake', tIndex: 0, to: VAULT, memo: MEMO, mainnet: false };

  test('plans with no key, then builds, signs and pays exactly the review', async () => {
    const keys = new wasm.SpendKeys(SEED, 0, false);
    try {
      const own = p2pkh(keys.transparent_pubkey(0));
      const { chain, broadcast } = chainWith(own, [600_000n, 400_000n]);

      expect(await planDeposit(wasm, chain, { ...req, amountZat: '2000000' })).toEqual({
        fee: '25000',
        change: '0',
        short: String(2_000_000 + 25_000 - 1_000_000),
      });
      const plan = await planDeposit(wasm, chain, { ...req, amountZat: '700000' });
      expect(plan).toEqual({ fee: '25000', change: '275000', short: '0' });

      const sent = await sendDeposit(wasm, chain, keys, {
        ...req,
        amountZat: '700000',
        reviewedFee: plan.fee,
      });
      expect(broadcast).toHaveBeenCalledWith(sent.txHex);
      expect(sent.txHex.slice(0, 8)).toBe('05000080');
      expect(transparentOutputs(sent.txHex)).toEqual([
        { value: 700_000n, script: VAULT_SCRIPT },
        { value: 0n, script: opReturnScript(MEMO_HEX) },
        { value: 275_000n, script: own },
      ]);
    } finally {
      keys.free();
    }
  });

  test("a swap's own address signs with its own index, and only that one", async () => {
    const keys = new wasm.SpendKeys(SEED, 0, false);
    try {
      const own = p2pkh(keys.transparent_pubkey(7));
      const { chain, broadcast } = chainWith(own, [900_000n]);
      const plan = await planDeposit(wasm, chain, { ...req, tIndex: 7, amountZat: '500000' });
      const deposit = { ...req, amountZat: '500000', reviewedFee: plan.fee };
      // the pocket's shown address (index 0) never signs a swap's inputs
      await expect(sendDeposit(wasm, chain, keys, deposit)).rejects.toThrow(
        /not a P2PKH output of this key/,
      );
      const sent = await sendDeposit(wasm, chain, keys, { ...deposit, tIndex: 7 });
      expect(broadcast).toHaveBeenCalledTimes(1);
      // change and any refund go back to the swap's own address
      expect(transparentOutputs(sent.txHex).at(-1)?.script).toBe(own);
    } finally {
      keys.free();
    }
  });

  test('a fee that moved since the review, or another pocket, sends nothing', async () => {
    const keys = new wasm.SpendKeys(SEED, 0, false);
    const other = new wasm.SpendKeys(SEED, 1, false);
    try {
      const { chain, broadcast } = chainWith(p2pkh(keys.transparent_pubkey(0)), [900_000n]);
      const deposit = { ...req, amountZat: '500000', reviewedFee: '20000' };
      await expect(sendDeposit(wasm, chain, keys, deposit)).rejects.toThrow(FEE_MOVED);
      await expect(
        sendDeposit(wasm, chain, other, { ...deposit, reviewedFee: '25000' }),
      ).rejects.toThrow(/not a P2PKH output of this key/);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      keys.free();
      other.free();
    }
  });
});
