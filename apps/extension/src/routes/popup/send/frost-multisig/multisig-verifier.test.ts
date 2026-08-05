// Regression tests for the co-signing verifier.
//
// The threat model these encode: the relay is unauthenticated and rooms are
// joined by a guessable code, so "the host" is anyone who can post to the room.
// The verifier is the only thing standing between that and a released threshold
// share, and the specific failure it must not have is a state that fails to
// verify while still permitting a signature.

import { describe, expect, it } from 'vitest';
import {
  assessClaimedFee,
  computeVerdict,
  verdictAllowsSigning,
  MAX_PLAUSIBLE_FEE_ZAT,
  type Verdict,
} from './multisig-verifier';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';

// A real orchard receiver is 43 bytes; the encoder only needs well-formed
// bytes, and the tests below compare against whatever it produces.
const RECIPIENT_RAW = 'ab'.repeat(43);
const OTHER_RAW = 'cd'.repeat(43);
const SIGHASH = '11'.repeat(32);

const parsedWith = (over: Partial<FrostParsedTx> = {}): FrostParsedTx => ({
  actions: [
    {
      index: 0,
      decrypted: true,
      is_change: false,
      amount_zat: 100_000,
      recipient_raw_hex: RECIPIENT_RAW,
    },
  ] as FrostParsedTx['actions'],
  summary: {
    total_send_zat: 100_000,
    total_change_zat: 0,
    decrypted_count: 1,
    action_count: 1,
  },
  computed_sighash_hex: SIGHASH,
  ...over,
});

describe('computeVerdict — no unverifiable-but-signable state', () => {
  it('REFUSES when the sighash cannot be recomputed, rather than warning', () => {
    // This is the downgrade a host can force at will by adding a dust
    // transparent output: the parser returns null and the old code returned
    // `unverified`, which left the approve button live.
    const v = computeVerdict({
      parsed: parsedWith({ computed_sighash_hex: null }),
      claimedRecipient: 'anything',
      claimedAmountZat: '100000',
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
    expect(verdictAllowsSigning(v, true)).toBe(false);
    expect(verdictAllowsSigning(v, false)).toBe(false);
  });

  it('refuses on a null sighash even when the outputs would otherwise match', () => {
    // The dangerous shape: OVK decode agrees with the claim, so the old code
    // fell through to a green-ish state despite nothing binding the share.
    const v = computeVerdict({
      parsed: parsedWith({ computed_sighash_hex: null }),
      claimedRecipient: 'irrelevant-because-we-refuse-first',
      claimedAmountZat: '100000',
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
  });

  it('flags a sighash that disagrees with the bytes as a mismatch', () => {
    const v = computeVerdict({
      parsed: parsedWith(),
      claimedRecipient: 'x',
      claimedAmountZat: '100000',
      claimedSighashHex: '22'.repeat(32),
      mainnet: true,
    });
    expect(v.kind).toBe('mismatch');
    if (v.kind === 'mismatch') {
      expect(v.sighashLie).toBe(true);
    }
  });

  it('flags a split-spend (extra recipient output) as a mismatch', () => {
    const v = computeVerdict({
      parsed: parsedWith({
        actions: [
          {
            index: 0,
            decrypted: true,
            is_change: false,
            amount_zat: 100_000,
            recipient_raw_hex: RECIPIENT_RAW,
          },
          {
            index: 1,
            decrypted: true,
            is_change: false,
            amount_zat: 900_000,
            recipient_raw_hex: OTHER_RAW,
          },
        ] as FrostParsedTx['actions'],
      }),
      claimedRecipient: 'x',
      claimedAmountZat: '100000',
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('mismatch');
    if (v.kind === 'mismatch') {
      expect(v.reasons.join(' ')).toMatch(/split-spend/);
    }
  });
});

describe('verdictAllowsSigning', () => {
  const cases: [Verdict, boolean, boolean][] = [
    // verdict, acknowledged, may sign
    [{ kind: 'pending' }, false, false],
    [{ kind: 'pending' }, true, false],
    [{ kind: 'refuse', reasons: ['nope'] }, false, false],
    // acknowledging must NOT unlock a refuse — there is nothing to acknowledge,
    // the user was shown no verified data at all.
    [{ kind: 'refuse', reasons: ['nope'] }, true, false],
    [{ kind: 'mismatch', reasons: ['r'], sendZat: 0n, changeZat: 0n }, false, false],
    [{ kind: 'mismatch', reasons: ['r'], sendZat: 0n, changeZat: 0n }, true, true],
    [{ kind: 'match', sendZat: 1n, changeZat: 0n }, false, true],
  ];
  it.each(cases)('%o ack=%s → %s', (verdict, ack, expected) => {
    expect(verdictAllowsSigning(verdict, ack)).toBe(expected);
  });
});

describe('assessClaimedFee — a sanity bound, not verification', () => {
  it('accepts an ordinary fee', () => {
    expect(assessClaimedFee('10000', '100000').ok).toBe(true);
  });

  it('rejects a fee above the sanity bound', () => {
    expect(assessClaimedFee(String(MAX_PLAUSIBLE_FEE_ZAT + 1n), '10000000000').ok).toBe(false);
  });

  it('rejects a fee larger than the amount being sent', () => {
    expect(assessClaimedFee('200000', '100000').ok).toBe(false);
  });

  it('rejects a negative or non-numeric fee', () => {
    expect(assessClaimedFee('-1', '100000').ok).toBe(false);
    expect(assessClaimedFee('not-a-number', '100000').ok).toBe(false);
  });

  it('DOCUMENTS THE HOLE: a lied-about small fee passes', () => {
    // The fee-theft attack is: spend a 10 ZEC note, send 0.01 to the displayed
    // recipient, emit no change, let 9.99 fall out as fee to a colluding miner
    // — while claiming a normal fee here. Nothing on this side of the wasm
    // boundary can catch that, because `frost_inspect_pczt_outputs` never
    // returns the bundle's value_balance. If this test ever starts failing
    // because a real conservation check was added, delete it.
    expect(assessClaimedFee('10000', '1000000').ok).toBe(true);
  });
});
