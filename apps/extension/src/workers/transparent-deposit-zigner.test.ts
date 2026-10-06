// A THORChain deposit signed by zigner, end to end with no device: zafu builds
// the unsigned PCZT for a cold wallet (the pubkey from its UFVK at the swap's
// own index), zigner's module code signs it (rust/pczt_signing `sign_request`,
// zigner feat/op-return-review f6f68021, the same seed), and zafu applies the
// device's signatures to its own PCZT, finalizes, and checks the bytes against
// the review. Zigner refuses the same PCZT as a compact (0x05) request:
// "compact signatures-only response unsupported for a PCZT with transparent
// inputs", so the deposit always asks full.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SpendKeysCtor } from './hot-sign';
import {
  buildDeposit,
  finishColdDeposit,
  finishDeposit,
  opReturnScript,
  signedDepositTx,
  transparentOutputs,
  transparentSignaturesOf,
  type DepositChain,
  type DepositWasm,
  type FinalizeWasm,
} from './transparent-deposit';
import { parsePreludeSinglePcztResponse } from '../routes/popup/send/zcash-send-cbor-helpers';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MEMO = '=:ETH.USDC:0xf3e03d4905725065Cc2E342Fc56BD1769A29E322:0/1/0:zafu:50';
const MEMO_HEX = bytesToHex(new TextEncoder().encode(MEMO));
/** mainnet P2PKH of hash160 0x42 * 20 */
const VAULT = 't1Puwyjt8X8r9B4yr9PvVJ93Vu5phobsGqJ';
const VAULT_SCRIPT = `76a914${'42'.repeat(20)}88ac`;
/** the swap's own t-branch index */
const INDEX = 57;

/** zigner's 0x03 answer to the request this file builds */
const ZIGNER_ANSWER = [
  '530403f5f9f8ecfb4d13cf8b31783d88dd7da099f957c0c9df7bc1b629ad9baea153c7eb02000050435a540100000005',
  '8ace9cb502dbac94bd03010088d0d5018501000002010101010101010101010101010101010101010101010101010101',
  '01010101010000000000c0cf241976a914a115e87cc4120aa8d73e983b10c4f4f072e9106288ac00010222784169f612',
  '4d7c8c2480506912a6cb66799b8e2a66072a98ce420ffe520df748304502210088fe5cdae9d3cf02c4f4be524bfa15ff',
  '53b0367c14ac2b67131262792e96e8c20220546b99752224166f3ef823e8b780243727ac7d84fe3afc27c4c8101ca82f',
  'e505010100000001a115e87cc4120aa8d73e983b10c4f4f072e91062210222784169f6124d7c8c2480506912a6cb6679',
  '9b8e2a66072a98ce420ffe520df700000202020202020202020202020202020202020202020202020202020202020202',
  '010000000080b5181976a914a115e87cc4120aa8d73e983b10c4f4f072e9106288ac00010222784169f6124d7c8c2480',
  '506912a6cb66799b8e2a66072a98ce420ffe520df7473044022069c47e4e794daba35507fd2aed424c3b12c92a8b27d8',
  '88a3001614b62aac8218022060f200747901af1cad094818ac4192e28a1dfc31951a91ffae252244350f44a201010000',
  '0001a115e87cc4120aa8d73e983b10c4f4f072e91062210222784169f6124d7c8c2480506912a6cb66799b8e2a66072a',
  '98ce420ffe520df7000003e0dc2a1976a914424242424242424242424242424242424242424288ac0000000000456a43',
  '3d3a4554482e555344433a30786633653033643439303537323530363543633245333432466335364244313736394132',
  '39453332323a302f312f303a7a6166753a353000000000b8e4101976a914a115e87cc4120aa8d73e983b10c4f4f072e9',
  '106288ac0000000000000000000000000000000000000000000000000000000000000000000000000000000100000000',
  '000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000',
  '000000000000000000000000000000000000',
].join('');

interface Wasm extends DepositWasm, FinalizeWasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: SpendKeysCtor & (new (...a: never[]) => { ufvk(): string; free(): void });
  transparent_pubkey_from_ufvk(ufvk: string, index: number): string;
  transparent_address_from_ufvk(ufvk: string, index: number): string;
}

describe('a zigner-signed deposit', () => {
  let wasm: Wasm;
  let ufvk: string;
  let pubkey: string;
  beforeAll(async () => {
    wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    const keys = new wasm.SpendKeys(SEED, 0, true);
    ufvk = keys.ufvk();
    keys.free();
    pubkey = wasm.transparent_pubkey_from_ufvk(ufvk, INDEX);
  });

  const chainOf = (script: string) => {
    const broadcast = vi.fn((txHex: string) => Promise.resolve(txHex.slice(0, 64)));
    const chain: DepositChain = {
      utxos: () =>
        Promise.resolve(
          [600_000n, 400_000n].map((valueZat, i) => ({
            txid: new Uint8Array(32).fill(i + 1),
            outputIndex: i,
            valueZat,
            script: hexToBytes(script),
          })),
        ),
      // mainnet, NU6.3
      tip: () => Promise.resolve(3_499_999),
      branchId: () => Promise.resolve(0x37a5165b),
      broadcast,
    };
    return { chain, broadcast };
  };

  const req = {
    tAddress: 'unused-by-the-fake',
    tIndex: INDEX,
    to: VAULT,
    memo: MEMO,
    amountZat: '700000',
    mainnet: true,
    reviewedFee: '25000',
  };

  const own = async () => {
    const { transparentAddressToScriptHex } = await import('../ledger/address');
    return transparentAddressToScriptHex(wasm.transparent_address_from_ufvk(ufvk, INDEX), true);
  };

  test('the ufvk key at the swap index owns the swap address (external scope)', async () => {
    const keys = new wasm.SpendKeys(SEED, 0, true);
    try {
      expect(pubkey).toBe(keys.transparent_pubkey(INDEX));
    } finally {
      keys.free();
    }
    const built = await buildDeposit(wasm, chainOf(await own()).chain, pubkey, req);
    expect(built.want.ownScript).toBe(await own());
  });

  test("zigner's signatures finish zafu's own PCZT into exactly the reviewed deposit", async () => {
    const { chain, broadcast } = chainOf(await own());
    const built = await buildDeposit(wasm, chain, pubkey, req);
    const { signedPczt } = parsePreludeSinglePcztResponse(hexToBytes(ZIGNER_ANSWER));
    expect(transparentSignaturesOf(signedPczt, pubkey)).toHaveLength(2);

    const txHex = signedDepositTx(wasm, built.pcztHex, signedPczt, pubkey);
    const sent = await finishDeposit(chain, txHex, built.want, req.reviewedFee);
    expect(broadcast).toHaveBeenCalledWith(txHex);
    expect(sent.txHex.slice(0, 8)).toBe('05000080');
    expect(transparentOutputs(sent.txHex)).toEqual([
      { value: 700_000n, script: VAULT_SCRIPT },
      { value: 0n, script: opReturnScript(MEMO_HEX) },
      { value: 275_000n, script: await own() },
    ]);
  });

  test('the cold finish holds the signed bytes to the review, with the swap address as change', async () => {
    const { chain, broadcast } = chainOf(await own());
    const built = await buildDeposit(wasm, chain, pubkey, req);
    const { signedPczt } = parsePreludeSinglePcztResponse(hexToBytes(ZIGNER_ANSWER));
    const tAddress = wasm.transparent_address_from_ufvk(ufvk, INDEX);
    const signed = { unsignedPcztHex: built.pcztHex, signedPczt, pubkeyHex: pubkey };
    const sent = await finishColdDeposit(wasm, chain, { ...req, tAddress }, signed);
    expect(broadcast).toHaveBeenCalledWith(sent.txHex);
    // the same signed bytes against another review are never broadcast
    const elsewhere = wasm.transparent_address_from_ufvk(ufvk, INDEX + 1);
    await expect(
      finishColdDeposit(wasm, chain, { ...req, tAddress: elsewhere }, signed),
    ).rejects.toThrow(/does not match/);
    await expect(
      finishColdDeposit(wasm, chain, { ...req, tAddress, memo: 'another memo' }, signed),
    ).rejects.toThrow(/does not match/);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  test('a signature that is not for this deposit is refused before anything is sent', async () => {
    const { chain, broadcast } = chainOf(await own());
    const built = await buildDeposit(wasm, chain, pubkey, req);
    const { signedPczt } = parsePreludeSinglePcztResponse(hexToBytes(ZIGNER_ANSWER));
    // another amount: zafu's PCZT has other sighashes than the ones zigner signed
    const other = await buildDeposit(wasm, chain, pubkey, { ...req, amountZat: '600000' });
    expect(() => signedDepositTx(wasm, other.pcztHex, signedPczt, pubkey)).toThrow();
    // one flipped byte inside a signature
    const [first] = transparentSignaturesOf(signedPczt, pubkey);
    const at = bytesToHex(signedPczt).indexOf(first!.sig_hex) / 2 + 10;
    const bent = signedPczt.slice();
    bent[at] ^= 0x01;
    expect(() => signedDepositTx(wasm, built.pcztHex, bent, pubkey)).toThrow();
    // another key's view of the same answer finds nothing to apply
    const elsewhere = wasm.transparent_pubkey_from_ufvk(ufvk, INDEX + 1);
    expect(() => signedDepositTx(wasm, built.pcztHex, signedPczt, elsewhere)).toThrow(/unsigned/);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
