// An lp add and a take-out ask, built and signed on the real shipped wasm with
// no network: the memo rides in the OP_RETURN, the vault is today's tex1 paid
// as its P2PKH twin, and change goes back to the lp address itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SpendKeysCtor } from '../workers/hot-sign';
import { transparentAddressToScriptHex } from '../ledger/address';
import {
  depositFeeZat,
  opReturnScript,
  planDeposit,
  sendDeposit,
  transparentOutputs,
  type DepositChain,
  type DepositWasm,
} from '../workers/transparent-deposit';
import { PAYABLE_ZEC_VAULT } from '../state/swap/thornode';
import { ADD_MEMO, MIN_ADD_ZAT, withdrawMemo } from './math';

type Wasm = DepositWasm & { initSync: (o: { module: Buffer }) => void; SpendKeys: SpendKeysCtor };

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** THORChain's zec vault, read from inbound_addresses on 2026-10-05 */
const VAULT = 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v';
const LP_INDEX = 21;

const p2pkh = (pubkeyHex: string) =>
  `76a914${bytesToHex(ripemd160(sha256(hexToBytes(pubkeyHex))))}88ac`;
const memoHex = (m: string) => bytesToHex(new TextEncoder().encode(m));

describe('an lp deposit on the real wasm', () => {
  let wasm: Wasm;
  let keys: InstanceType<SpendKeysCtor>;
  let own: string;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    keys = new wasm.SpendKeys(SEED, 0, true);
    own = p2pkh(keys.transparent_pubkey(LP_INDEX));
  });
  afterAll(() => keys.free());

  const chainWith = (values: bigint[]): DepositChain => ({
    utxos: () =>
      Promise.resolve(
        values.map((valueZat, i) => ({
          txid: new Uint8Array(32).fill(i + 7),
          outputIndex: 0,
          valueZat,
          script: hexToBytes(own),
        })),
      ),
    tip: () => Promise.resolve(3_100_000),
    branchId: () => Promise.resolve(0xc8e71055),
    broadcast: (txHex: string) => Promise.resolve(txHex.slice(0, 64)),
  });

  const req = { tAddress: 'the-lp-address', tIndex: LP_INDEX, to: VAULT, mainnet: true };

  test("today's vault is a tex1 the deposit can pay", () => {
    expect(PAYABLE_ZEC_VAULT.test(VAULT)).toBe(true);
  });

  test('a 0.002 add with change: vault, then +:ZEC.ZEC, then change back to the lp address', async () => {
    const chain = chainWith([300_000n]);
    const amountZat = MIN_ADD_ZAT.toString();
    const plan = await planDeposit(wasm, chain, { ...req, memo: ADD_MEMO, amountZat });
    expect(plan.short).toBe('0');
    expect(BigInt(plan.fee)).toBe(depositFeeZat(ADD_MEMO.length));
    const sent = await sendDeposit(wasm, chain, keys, {
      ...req,
      memo: ADD_MEMO,
      amountZat,
      reviewedFee: plan.fee,
    });
    const [pay, memo, change, ...rest] = transparentOutputs(sent.txHex);
    expect(pay).toEqual({
      value: MIN_ADD_ZAT,
      script: await transparentAddressToScriptHex(VAULT, true),
    });
    expect(memo).toEqual({ value: 0n, script: opReturnScript(memoHex(ADD_MEMO)) });
    expect(change).toEqual({ value: 300_000n - MIN_ADD_ZAT - BigInt(plan.fee), script: own });
    expect(rest).toEqual([]);
  });

  test('the take-out ask: dust from the lp address with -:ZEC.ZEC:<bps>', async () => {
    const chain = chainWith([25_000n]);
    const memoText = withdrawMemo(5_000);
    const plan = await planDeposit(wasm, chain, { ...req, memo: memoText, amountZat: '15000' });
    expect(plan.short).toBe('0');
    const sent = await sendDeposit(wasm, chain, keys, {
      ...req,
      memo: memoText,
      amountZat: '15000',
      reviewedFee: plan.fee,
    });
    const [pay, memo] = transparentOutputs(sent.txHex);
    expect(pay!.value).toBe(15_000n);
    expect(memo!.script).toBe(opReturnScript(memoHex('-:ZEC.ZEC:5000')));
  });

  test('a lp address short of the ask says by how much, and builds nothing', async () => {
    const plan = await planDeposit(wasm, chainWith([10_000n]), {
      ...req,
      memo: withdrawMemo(10_000),
      amountZat: '15000',
    });
    expect(BigInt(plan.short)).toBe(15_000n + BigInt(plan.fee) - 10_000n);
  });
});
