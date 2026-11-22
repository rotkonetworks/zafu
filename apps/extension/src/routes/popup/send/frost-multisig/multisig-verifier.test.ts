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
  computeEscrowVerdict,
  computeVerdict,
  verdictAllowsSigning,
  MAX_PLAUSIBLE_FEE_ZAT,
  type Verdict,
} from './multisig-verifier';
import type { FrostParsedAction, FrostParsedTx } from '../../../../state/keyring/network-worker';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import { hexToBytes } from '@noble/hashes/utils';

// A real orchard receiver is 43 bytes; the encoder only needs well-formed
// bytes, and the tests below compare against whatever it produces.
const RECIPIENT_RAW = 'ab'.repeat(43);
const OTHER_RAW = 'cd'.repeat(43);
const SIGHASH = '11'.repeat(32);

const CHANGE_RAW = 'ef'.repeat(43);
const FEE = '10000';
const RECIPIENT = encodeOrchardUnifiedAddress(hexToBytes(RECIPIENT_RAW), true);

/** an action as frost_inspect_pczt_outputs reports it: OVK view and committed view */
const action = (
  index: number,
  valueZat: number,
  raw: string,
  o: { decrypted?: boolean; isChange?: boolean; scope?: 'external' | 'internal' | null } = {},
): FrostParsedAction => {
  const decrypted = o.decrypted ?? true;
  return {
    index,
    decrypted,
    is_change: o.isChange ?? false,
    // what OVK decryption shows: nothing at all for an output it cannot open
    amount_zat: decrypted ? valueZat : 0,
    recipient_raw_hex: decrypted ? raw : null,
    pool: 'orchard',
    cmx_verified: true,
    committed_value_zat: valueZat,
    committed_recipient_raw_hex: raw,
    recipient_scope: o.scope === undefined ? null : o.scope,
  };
};

const parsedWith = (over: Partial<FrostParsedTx> = {}): FrostParsedTx => ({
  actions: [action(0, 100_000, RECIPIENT_RAW)],
  summary: {
    total_send_zat: 100_000,
    total_change_zat: 0,
    decrypted_count: 1,
    action_count: 1,
  },
  computed_sighash_hex: SIGHASH,
  committed_outputs_error: null,
  sapling_present: false,
  transparent_input_count: 0,
  transparent_outputs: [],
  fee_zat: Number(FEE),
  ...over,
});

const verdict = (parsed: FrostParsedTx, claim: { amount?: string; fee?: string } = {}) =>
  computeVerdict({
    parsed,
    claimedRecipient: RECIPIENT,
    claimedAmountZat: claim.amount ?? '100000',
    claimedFeeZat: claim.fee ?? FEE,
    claimedSighashHex: SIGHASH,
    mainnet: true,
  });

describe('computeVerdict - no unverifiable-but-signable state', () => {
  it('REFUSES when the sighash cannot be recomputed, rather than warning', () => {
    // This is the downgrade a host can force at will by adding a dust
    // transparent output: the parser returns null and the old code returned
    // `unverified`, which left the approve button live.
    const v = computeVerdict({
      parsed: parsedWith({ computed_sighash_hex: null }),
      claimedRecipient: 'anything',
      claimedAmountZat: '100000',
      claimedFeeZat: FEE,
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
      claimedFeeZat: FEE,
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
  });

  it('refuses a sighash that disagrees with the bytes, with no approve-anyway', () => {
    const v = computeVerdict({
      parsed: parsedWith(),
      claimedRecipient: 'x',
      claimedAmountZat: '100000',
      claimedFeeZat: FEE,
      claimedSighashHex: '22'.repeat(32),
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
    expect(verdictAllowsSigning(v, true)).toBe(false);
  });

  it('flags a split-spend (extra recipient output) as a mismatch', () => {
    const v = computeVerdict({
      parsed: parsedWith({
        actions: [action(0, 100_000, RECIPIENT_RAW), action(1, 900_000, OTHER_RAW)],
      }),
      claimedRecipient: 'x',
      claimedAmountZat: '100000',
      claimedFeeZat: FEE,
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('mismatch');
    if (v.kind === 'mismatch') {
      expect(v.reasons.join(' ')).toMatch(/split-spend/);
    }
  });
});

describe('computeVerdict - outputs are judged as committed, not as the OVK shows them', () => {
  it('matches an honest payment with change to the group', () => {
    const v = verdict(
      parsedWith({
        actions: [
          action(0, 100_000, RECIPIENT_RAW, { scope: null }),
          action(1, 50_000, CHANGE_RAW, { isChange: true, scope: 'internal' }),
        ],
      }),
    );
    expect(v).toEqual({ kind: 'match', sendZat: 100_000n, changeZat: 50_000n });
  });

  it('REFUSES a second output hidden from the group OVK (the reported attack)', () => {
    // the host pays the claimed recipient honestly and adds a large output to
    // itself encrypted to a throwaway OVK: OVK decryption sees zero for it
    const v = verdict(
      parsedWith({
        actions: [
          action(0, 100_000, RECIPIENT_RAW),
          action(1, 500_000_000, OTHER_RAW, { decrypted: false }),
        ],
      }),
    );
    expect(v.kind).toBe('refuse');
    expect(verdictAllowsSigning(v, true)).toBe(false);
    if (v.kind === 'refuse') {
      expect(v.reasons.join(' ')).toMatch(/500000000 zat is hidden/);
    }
  });

  it('ignores a zero-value dummy the OVK cannot open', () => {
    const v = verdict(
      parsedWith({
        actions: [action(0, 100_000, RECIPIENT_RAW), action(1, 0, OTHER_RAW, { decrypted: false })],
      }),
    );
    expect(v.kind).toBe('match');
  });

  it('REFUSES a fee the value balances do not agree with (value leaving as fee)', () => {
    const v = verdict(parsedWith({ fee_zat: 999_900_000 }));
    expect(v.kind).toBe('refuse');
    expect(verdictAllowsSigning(v, true)).toBe(false);
  });

  it('REFUSES change that pays an address outside the group', () => {
    const v = verdict(
      parsedWith({
        actions: [
          action(0, 100_000, RECIPIENT_RAW),
          action(1, 50_000, OTHER_RAW, { isChange: true, scope: null }),
        ],
      }),
    );
    expect(v.kind).toBe('refuse');
  });

  it('REFUSES when an output does not verify against its commitment', () => {
    const v = verdict(
      parsedWith({ actions: [{ ...action(0, 100_000, RECIPIENT_RAW), cmx_verified: false }] }),
    );
    expect(v.kind).toBe('refuse');
  });

  it('REFUSES an inspection without the committed view (an older wasm), never falling back', () => {
    const { committed_outputs_error: _gone, ...older } = parsedWith();
    expect(verdict(older as FrostParsedTx).kind).toBe('refuse');
  });

  it('REFUSES transparent outputs and inputs, and sapling', () => {
    for (const over of [
      { transparent_outputs: [{ value_zat: 1, script_pubkey_hex: '00', address: 't1x' }] },
      { transparent_input_count: 1 },
      { sapling_present: true },
    ] as Partial<FrostParsedTx>[]) {
      expect(verdict(parsedWith(over)).kind).toBe('refuse');
    }
  });
});

describe('computeEscrowVerdict - a payout hides nothing either', () => {
  it('lists an honest payout', () => {
    const v = computeEscrowVerdict({
      parsed: parsedWith(),
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('ok');
  });

  it('REFUSES an output hidden from the group OVK', () => {
    const v = computeEscrowVerdict({
      parsed: parsedWith({
        actions: [
          action(0, 100_000, RECIPIENT_RAW),
          action(1, 9_000_000, OTHER_RAW, { decrypted: false }),
        ],
      }),
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
  });

  it('REFUSES a fee larger than the payout', () => {
    const v = computeEscrowVerdict({
      parsed: parsedWith({ actions: [action(0, 5_000, RECIPIENT_RAW)], fee_zat: 9_000 }),
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
  });

  it('REFUSES a fee above the sanity bound', () => {
    const v = computeEscrowVerdict({
      parsed: parsedWith({ fee_zat: Number(MAX_PLAUSIBLE_FEE_ZAT) + 1 }),
      claimedSighashHex: SIGHASH,
      mainnet: true,
    });
    expect(v.kind).toBe('refuse');
  });
});

describe('verdictAllowsSigning', () => {
  const cases: [Verdict, boolean, boolean][] = [
    // verdict, acknowledged, may sign
    [{ kind: 'pending' }, false, false],
    [{ kind: 'pending' }, true, false],
    [{ kind: 'refuse', reasons: ['nope'] }, false, false],
    // acknowledging must NOT unlock a refuse - there is nothing to acknowledge,
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

describe('assessClaimedFee - a sanity bound, not verification', () => {
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

  it('a lied-about small fee passes this bound; computeVerdict catches it from the value balances', () => {
    expect(assessClaimedFee('10000', '1000000').ok).toBe(true);
    expect(verdict(parsedWith({ fee_zat: 999_000_000 }), { fee: '10000' }).kind).toBe('refuse');
  });
});
