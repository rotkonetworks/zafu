// The co-signer review judges outputs by their committed view (see
// multisig-verifier.ts computeVerdict). It refuses when a field it needs is
// missing, so a wasm that stopped reporting one would refuse every honest
// request. This pins the shape the shipped wasm returns, on a real PCZT.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';
import { computeVerdict } from './multisig-verifier';

// the seed and fixture of workers/swap-one-round-zigner.test.ts: a real
// orchard -> transparent move, inspected with its own wallet's viewing key
const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

interface Wasm {
  initSync(opts: { module: Uint8Array }): void;
  SpendKeys: new (
    seed: string,
    account: number,
    mainnet: boolean,
  ) => { ufvk(): string; free(): void };
  frost_inspect_pczt_outputs(pczt: string, ufvk: string): string;
}

describe('frost_inspect_pczt_outputs reports what the review needs', () => {
  let parsed: FrostParsedTx;

  beforeAll(async () => {
    const wasm = (await import('@repo/zcash-wasm')) as unknown as Wasm;
    wasm.initSync({
      module: readFileSync(resolve(process.cwd(), '../../packages/zcash-wasm/zafu_wasm_bg.wasm')),
    });
    const keys = new wasm.SpendKeys(SEED, 0, true);
    const ufvk = keys.ufvk();
    keys.free();
    const pczt = readFileSync(
      resolve(__dirname, '../../../../workers/fixtures/swap-one-round-move-retained.hex'),
      'utf8',
    ).trim();
    parsed = JSON.parse(wasm.frost_inspect_pczt_outputs(pczt, ufvk)) as FrostParsedTx;
  });

  test('every committed and transaction-level field, with the types the review reads', () => {
    expect(parsed.committed_outputs_error).toBeNull();
    expect(typeof parsed.sapling_present).toBe('boolean');
    expect(Number.isSafeInteger(parsed.transparent_input_count)).toBe(true);
    expect(Array.isArray(parsed.transparent_outputs)).toBe(true);
    expect(Number.isSafeInteger(parsed.fee_zat)).toBe(true);
    expect(parsed.computed_sighash_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.actions.length).toBeGreaterThan(0);
    for (const a of parsed.actions) {
      expect(a.cmx_verified).toBe(true);
      expect(Number.isSafeInteger(a.committed_value_zat)).toBe(true);
      expect(a.committed_recipient_raw_hex).toMatch(/^[0-9a-f]{86}$/);
      expect(['external', 'internal', null]).toContain(a.recipient_scope);
      expect(typeof a.decrypted).toBe('boolean');
    }
  });

  test('a transparent payout is refused by the group review, never matched', () => {
    const v = computeVerdict({
      parsed,
      claimedRecipient: 'anything',
      claimedAmountZat: '1',
      claimedFeeZat: String(parsed.fee_zat),
      claimedSighashHex: parsed.computed_sighash_hex!,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
  });
});
