// A zigner swap in one QR round, end to end with no device: the move zcli
// built and proved (V6 ironwood -> the swap's own address, the zigner test
// seed's mainnet keys, t-index 57; zcli tests/move_txid_before_signing.rs),
// the deposit zafu builds against that move's output before anything is
// signed, one 0x04 batch carrying both, and zigner's answer to exactly that
// batch from the SHIPPED module0.wasm (zigner tests/swap_one_round.rs).
// Fixtures: ./fixtures/swap-one-round-*.hex.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  buildDeposit,
  checkDeposit,
  coldDepositTx,
  MOVE_MISMATCH,
  moveCoin,
  transparentInputs,
  transparentOutputs,
  withCoin,
  type DepositChain,
  type DepositWasm,
  type FinalizeWasm,
  type MoveInspected,
} from './transparent-deposit';
import { parseExpiryHeight } from './sent-tx-reconcile';
import { moveAndDeposit, type Held } from '../signing/move-and-deposit';
import { signedPcztsOfBatchAnswer } from '../signing/zigner-answer';
import { cborWrapPczt, zignerBatchEnvelope } from '../routes/popup/send/zcash-send-cbor-helpers';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MEMO = '=:ETH.USDC:0xf3e03d4905725065Cc2E342Fc56BD1769A29E322:0/1/0:zafu:50';
const VAULT = 't1Puwyjt8X8r9B4yr9PvVJ93Vu5phobsGqJ';
const INDEX = 57;
const SHORT = '425000';
/** sha256 of the batch request zigner signed (its tests/fixtures/swap_one_round_request.hex) */
const REQUEST_SHA256 = '70d8ec764c2722ec07bea29d452d1bbdaabe92a03a0f592ccb2f8ca2862fb500';

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, `fixtures/swap-one-round-${name}.hex`), 'utf8').trim();

interface Wasm extends DepositWasm, FinalizeWasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: new (
    seed: string,
    account: number,
    mainnet: boolean,
  ) => {
    ufvk(): string;
    free(): void;
  };
  transparent_pubkey_from_ufvk(ufvk: string, index: number): string;
  transparent_address_from_ufvk(ufvk: string, index: number): string;
  frost_inspect_pczt_outputs(pczt: string, ufvk: string): string;
  extract_signed_tx_from_pczt(pczt: string): string;
  compute_txid(txHex: string): string;
}

/** an empty swap address: the move's coin is all the deposit spends */
const emptyChain: DepositChain = {
  utxos: () => Promise.resolve([]),
  tip: () => Promise.resolve(3_500_000),
  branchId: () => Promise.resolve(0x37a5165b),
  broadcast: () => Promise.reject(new Error('nothing is broadcast here')),
};

const display = (wire: string) => wire.match(/../g)!.reverse().join('');

describe('one zigner round for the move and the swap', () => {
  let wasm: Wasm;
  let ufvk: string;
  let pubkey: string;
  let tAddress: string;
  let req: {
    tAddress: string;
    tIndex: number;
    to: string;
    amountZat: string;
    memo: string;
    mainnet: boolean;
    reviewedFee: string;
  };
  let inspected: MoveInspected;

  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    const keys = new wasm.SpendKeys(SEED, 0, true);
    ufvk = keys.ufvk();
    keys.free();
    pubkey = wasm.transparent_pubkey_from_ufvk(ufvk, INDEX);
    tAddress = wasm.transparent_address_from_ufvk(ufvk, INDEX);
    req = {
      tAddress,
      tIndex: INDEX,
      to: VAULT,
      amountZat: '400000',
      memo: MEMO,
      mainnet: true,
      reviewedFee: '25000',
    };
    inspected = JSON.parse(
      wasm.frost_inspect_pczt_outputs(fixture('move-retained'), ufvk),
    ) as MoveInspected;
  });

  const answer = () => cborWrapPczt(hexToBytes(fixture('answer')));

  test('the move pays the swap address, and its txid is read before it is signed', () => {
    const coin = moveCoin(inspected, tAddress, SHORT);
    expect(coin).toMatchObject({ vout: 0, value: SHORT, expiry: 3_500_040 });
    // the device signed it; the signed tx has exactly the txid the deposit spends
    const [signedMove] = signedPcztsOfBatchAnswer(answer(), 2);
    const txHex = wasm.extract_signed_tx_from_pczt(signedMove!);
    expect(display(wasm.compute_txid(txHex))).toBe(coin.txid);
    // a move that funds anything else is refused before a deposit is built for it
    expect(() => moveCoin(inspected, tAddress, '424999')).toThrow(MOVE_MISMATCH);
    expect(() => moveCoin(inspected, VAULT, SHORT)).toThrow(MOVE_MISMATCH);
  });

  test("zafu's batch is the one zigner signed, and both come back finished", async () => {
    const coin = moveCoin(inspected, tAddress, SHORT);
    const built = await buildDeposit(wasm, withCoin(emptyChain, coin), pubkey, req);
    const envelope = zignerBatchEnvelope([
      hexToBytes(fixture('move-device')),
      hexToBytes(built.pcztHex),
    ]);
    expect(bytesToHex(sha256(envelope))).toBe(REQUEST_SHA256);

    const [, signedDeposit] = signedPcztsOfBatchAnswer(answer(), 2);
    const txHex = await coldDepositTx(wasm, req, {
      unsignedPcztHex: built.pcztHex,
      signedPczt: hexToBytes(signedDeposit!),
      pubkeyHex: pubkey,
    });
    expect(transparentInputs(txHex)).toEqual([{ txid: coin.txid, vout: 0 }]);
    const [pay, memo, ...change] = transparentOutputs(txHex);
    expect(pay!.value).toBe(400_000n);
    expect(memo!.value).toBe(0n);
    expect(change).toEqual([]); // the move funds it exactly
    // it outlives the move: a move mined in time leaves a block for the deposit
    expect(parseExpiryHeight(txHex)).toBeGreaterThanOrEqual(coin.expiry);
  });

  test('the device answer must be whole and in order', () => {
    const bytes = hexToBytes(fixture('answer'));
    const tampered = bytes.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(() => signedPcztsOfBatchAnswer(cborWrapPczt(tampered), 2)).toThrow(/whole/);
    expect(() => signedPcztsOfBatchAnswer(answer(), 1)).toThrow(/asked for/);
  });

  test('signed bytes that pay anything but the review are refused, nothing held or sent', async () => {
    const coin = moveCoin(inspected, tAddress, SHORT);
    const built = await buildDeposit(wasm, withCoin(emptyChain, coin), pubkey, req);
    const [, signedDeposit] = signedPcztsOfBatchAnswer(answer(), 2);
    const signed = {
      unsignedPcztHex: built.pcztHex,
      signedPczt: hexToBytes(signedDeposit!),
      pubkeyHex: pubkey,
    };
    for (const other of [
      { ...req, amountZat: '400001' },
      { ...req, memo: `${MEMO}x` },
      { ...req, to: wasm.transparent_address_from_ufvk(ufvk, INDEX + 1) },
    ]) {
      await expect(coldDepositTx(wasm, other, signed)).rejects.toThrow(
        /does not match your review/,
      );
    }
    const txHex = await coldDepositTx(wasm, req, signed);
    expect(() =>
      checkDeposit(txHex, {
        toScript: `76a914${'42'.repeat(20)}88ac`,
        amountZat: 400_000n,
        memoHex: '00',
        ownScript: '',
      }),
    ).toThrow();
  });

  test('one round, both checked, the deposit held before the move goes out', async () => {
    const calls: string[] = [];
    let held: Held | undefined;
    const sent: string[] = [];
    const txid = await moveAndDeposit(
      {
        buildMove: () =>
          Promise.resolve({
            pcztHex: fixture('move-retained'),
            cborData: Uint8Array.of(0x53, 0x04, 0x03, ...hexToBytes(fixture('move-device'))),
            coldSendId: 'cold-1',
          }),
        inspect: pczt =>
          Promise.resolve(JSON.parse(wasm.frost_inspect_pczt_outputs(pczt, ufvk)) as MoveInspected),
        buildDeposit: async (coin, movePcztHex) => {
          const built = await buildDeposit(wasm, withCoin(emptyChain, coin), pubkey, req);
          const envelope = zignerBatchEnvelope([
            hexToBytes(movePcztHex),
            hexToBytes(built.pcztHex),
          ]);
          expect(bytesToHex(sha256(envelope))).toBe(REQUEST_SHA256);
          return { pcztHex: built.pcztHex, urFrames: ['ur:zigner-module/x'], cborData: envelope };
        },
        sign: () => (calls.push('sign'), Promise.resolve(signedPcztsOfBatchAnswer(answer(), 2))),
        finishDeposit: async (unsignedPcztHex, signedPcztHex) => {
          const txHex = await coldDepositTx(wasm, req, {
            unsignedPcztHex,
            signedPczt: hexToBytes(signedPcztHex),
            pubkeyHex: pubkey,
          });
          return { txHex, expiry: parseExpiryHeight(txHex)! };
        },
        extract: pczt => {
          const txHex = wasm.extract_signed_tx_from_pczt(pczt);
          return Promise.resolve({ txHex, txid: display(wasm.compute_txid(txHex)) });
        },
        hold: h => (calls.push(h ? 'hold' : 'let go'), (held = h), Promise.resolve()),
        broadcastMove: (txHex, coldSendId) => {
          calls.push('move');
          sent.push(txHex);
          expect(coldSendId).toBe('cold-1');
          return Promise.resolve('ignored');
        },
      },
      tAddress,
      SHORT,
    );
    expect(calls).toEqual(['sign', 'hold', 'move']);
    expect(held!.moveTxid).toBe(txid);
    expect(held!.moveExpiry).toBe(3_500_040);
    expect(transparentInputs(held!.txHex)).toEqual([{ txid, vout: 0 }]);
    expect(display(wasm.compute_txid(sent[0]!))).toBe(txid);
  });
});
