import { describe, expect, it } from 'vitest';
import { payableTransparentAddress } from '../ledger/address';

// Unit's guardians sign a deposit address in its base58 form while its api
// returns the tex form; this is the pair from the real mainnet response the
// wallet package verifies (networks/hyperliquid/unit.fixture.json)
describe("the form of a unit deposit address its guardians' signatures cover", () => {
  it('is the base58 twin of the tex address unit returns', async () => {
    expect(
      await payableTransparentAddress('tex1l5km43qgqjn2efn5fsn3rsjm9e0r4lg0uxj9je', true),
    ).toBe('t1gxHkDMNMeUtd66JVeNhurminNYrvtmWqd');
  });
});
