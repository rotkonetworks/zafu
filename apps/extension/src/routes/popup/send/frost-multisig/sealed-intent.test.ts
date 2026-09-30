// Regression tests for verifySealedIntent: the share-release check for async
// group payments. The property under test is that a device can only release a
// share for a PCZT that moves exactly what was sealed, and that anything it
// cannot establish from the PCZT is a refusal, never a pass.

import { describe, expect, it } from 'vitest';
import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import {
  verifySealedIntent,
  type IntentRejectCode,
  type IntentVerdict,
  type SealedIntent,
} from './multisig-verifier';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map(b => parseInt(b, 16)));

const RECIPIENT_RAW = 'ab'.repeat(43);
const OTHER_RAW = 'cd'.repeat(43);
const CHANGE_RAW = 'ef'.repeat(43);
const DUMMY_RAW = '12'.repeat(43);
const RECIPIENT_UA = encodeOrchardUnifiedAddress(hex(RECIPIENT_RAW), true);
const T_ADDR = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU';
const SIGHASH = '11'.repeat(32);
const GROUP = 'group-a';

const intent = (over: Partial<SealedIntent> = {}): SealedIntent => ({
  groupId: GROUP,
  outputs: [{ address: RECIPIENT_UA, amountZat: 600_000n }],
  feeCapZat: 20_000n,
  expiry: { minHeight: 3_000_010, maxHeight: 3_000_200 },
  mainnet: true,
  ...over,
});

type Action = FrostParsedTx['actions'][number];
const action = (
  index: number,
  raw: string,
  value: number,
  scope: Action['recipient_scope'],
  isChange = false,
): Action => ({
  index,
  pool: 'ironwood',
  amount_zat: value,
  recipient_raw_hex: raw,
  is_change: isChange,
  decrypted: true,
  committed_value_zat: value,
  committed_recipient_raw_hex: raw,
  cmx_verified: true,
  recipient_scope: scope,
});

/** An honest 1-in 2-out ironwood send: 600k to the recipient, 390k change, 10k fee. */
const honest = (over: Partial<FrostParsedTx> = {}): FrostParsedTx => ({
  actions: [
    action(0, RECIPIENT_RAW, 600_000, null),
    action(1, CHANGE_RAW, 390_000, 'internal', true),
  ],
  summary: {
    total_send_zat: 600_000,
    total_change_zat: 390_000,
    decrypted_count: 2,
    action_count: 2,
  },
  computed_sighash_hex: SIGHASH,
  expiry_height: 3_000_100,
  tx_version: 6,
  consensus_branch_id: 0x37a5165b,
  value_balance_zat: { orchard: 0, ironwood: 10_000, sapling: 0 },
  sapling_present: false,
  transparent_input_count: 0,
  transparent_input_total_zat: 0,
  transparent_outputs: [],
  fee_zat: 10_000,
  committed_outputs_error: null,
  ...over,
});

const verify = (parsed: unknown, i: SealedIntent = intent(), claimed?: string): IntentVerdict =>
  verifySealedIntent({ parsed, intent: i, localGroupId: GROUP, claimedSighashHex: claimed });

const codes = (v: IntentVerdict): IntentRejectCode[] => (v.ok ? [] : v.reasons.map(r => r.code));

describe('verifySealedIntent - match', () => {
  it('accepts the honest PCZT and returns the recomputed sighash', () => {
    const v = verify(honest(), intent(), SIGHASH);
    expect(v).toEqual({
      ok: true,
      sighashHex: SIGHASH,
      feeZat: 10_000n,
      changeZat: 390_000n,
      expiryHeight: 3_000_100,
    });
  });

  it('ignores zero-value dummy outputs, whoever they are addressed to', () => {
    const v = verify(
      honest({
        actions: [...honest().actions, action(2, DUMMY_RAW, 0, null)],
      }),
    );
    expect(v.ok).toBe(true);
  });

  it('matches a transparent recipient against the transparent outputs', () => {
    const v = verify(
      honest({
        actions: [action(0, CHANGE_RAW, 390_000, 'internal', true), action(1, DUMMY_RAW, 0, null)],
        transparent_outputs: [{ value_zat: 600_000, script_pubkey_hex: '76a914', address: T_ADDR }],
      }),
      intent({ outputs: [{ address: T_ADDR, amountZat: 600_000n }] }),
    );
    expect(v.ok).toBe(true);
  });

  it('pays each of several sealed recipients exactly once', () => {
    const two = intent({
      outputs: [
        { address: RECIPIENT_UA, amountZat: 300_000n },
        { address: RECIPIENT_UA, amountZat: 300_000n },
      ],
    });
    const ok = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 300_000, null),
          action(1, RECIPIENT_RAW, 300_000, null),
          action(2, CHANGE_RAW, 390_000, 'internal', true),
        ],
      }),
      two,
    );
    expect(ok.ok).toBe(true);
    // Only one of the two paid: the other is missing, the change absorbs it.
    const short = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 300_000, null),
          action(1, CHANGE_RAW, 690_000, 'internal', true),
        ],
      }),
      two,
    );
    expect(codes(short)).toContain('recipient_missing');
  });
});

describe('verifySealedIntent - wrong recipient / amount', () => {
  it('rejects a payment to a different address', () => {
    const v = verify(
      honest({
        actions: [
          action(0, OTHER_RAW, 600_000, null),
          action(1, CHANGE_RAW, 390_000, 'internal', true),
        ],
      }),
    );
    expect(codes(v)).toEqual(expect.arrayContaining(['unexpected_output', 'recipient_missing']));
  });

  it('rejects the right recipient with the wrong amount', () => {
    const v = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 599_999, null),
          action(1, CHANGE_RAW, 390_001, 'internal', true),
        ],
      }),
    );
    expect(codes(v)).toEqual(expect.arrayContaining(['amount_mismatch', 'recipient_missing']));
  });

  it('rejects when the coordinator claims a different sighash', () => {
    expect(codes(verify(honest(), intent(), '22'.repeat(32)))).toEqual(['sighash_mismatch']);
  });

  it('rejects an intent sealed for another group', () => {
    const v = verifySealedIntent({ parsed: honest(), intent: intent(), localGroupId: 'group-b' });
    expect(codes(v)).toEqual(['group_mismatch']);
  });
});

describe('verifySealedIntent - extra outputs', () => {
  it('rejects a split-spend to an extra foreign output', () => {
    const v = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 600_000, null),
          action(1, OTHER_RAW, 200_000, null),
          action(2, CHANGE_RAW, 190_000, 'internal', true),
        ],
      }),
    );
    expect(codes(v)).toEqual(['unexpected_output']);
  });

  it('rejects value hidden in an output that OVK decryption cannot see', () => {
    // The hole computeVerdict has to live with: an output encrypted to a
    // throwaway OVK shows up as `decrypted: false`. Its committed value is
    // still known, so it is caught here.
    const hidden: Action = {
      ...action(1, OTHER_RAW, 200_000, null),
      decrypted: false,
      amount_zat: 0,
      recipient_raw_hex: null,
    };
    const v = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 600_000, null),
          hidden,
          action(2, CHANGE_RAW, 190_000, 'internal', true),
        ],
      }),
    );
    expect(codes(v)).toEqual(['unexpected_output']);
  });

  it('rejects an unsealed transparent output', () => {
    const v = verify(
      honest({
        transparent_outputs: [{ value_zat: 1_000, script_pubkey_hex: '76a914', address: T_ADDR }],
      }),
    );
    expect(codes(v)).toEqual(['unexpected_output']);
  });

  it('rejects a transparent output with a non-standard script', () => {
    const v = verify(
      honest({
        transparent_outputs: [{ value_zat: 1_000, script_pubkey_hex: '6a', address: null }],
      }),
    );
    expect(codes(v)).toEqual(['unexpected_output']);
  });

  it('rejects value to the group’s own EXTERNAL scope (change is internal only)', () => {
    const v = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 600_000, null),
          action(1, CHANGE_RAW, 390_000, 'external'),
        ],
      }),
    );
    expect(codes(v)).toEqual(['unexpected_output']);
  });
});

describe('verifySealedIntent - change to a foreign address', () => {
  it('rejects "change" (internal-OVK) that pays an address the group does not own', () => {
    const v = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 600_000, null),
          action(1, OTHER_RAW, 390_000, null, true),
        ],
      }),
    );
    expect(codes(v)).toEqual(['change_to_foreign_address']);
  });
});

describe('verifySealedIntent - fee', () => {
  it('rejects a fee over the sealed cap', () => {
    // 10 ZEC in, 0.006 to the recipient, no change: the rest falls out as fee.
    const v = verify(
      honest({
        actions: [action(0, RECIPIENT_RAW, 600_000, null), action(1, DUMMY_RAW, 0, null)],
        value_balance_zat: { orchard: 0, ironwood: 999_400_000, sapling: 0 },
        fee_zat: 999_400_000,
      }),
    );
    expect(codes(v)).toEqual(['fee_over_cap']);
  });

  it('accepts a fee exactly at the cap', () => {
    expect(verify(honest({ fee_zat: 20_000 })).ok).toBe(true);
  });

  it('rejects when the fee is not derivable (negative balance -> null)', () => {
    expect(codes(verify(honest({ fee_zat: null })))).toEqual(['fee_unavailable']);
  });
});

describe('verifySealedIntent - expiry', () => {
  it('rejects an expiry outside the sealed bounds', () => {
    expect(codes(verify(honest({ expiry_height: 3_000_201 })))).toEqual(['expiry_out_of_bounds']);
    expect(codes(verify(honest({ expiry_height: 3_000_009 })))).toEqual(['expiry_out_of_bounds']);
  });

  it('rejects a non-expiring transaction (expiry 0)', () => {
    expect(codes(verify(honest({ expiry_height: 0 })))).toEqual(['expiry_unavailable']);
  });
});

describe('verifySealedIntent - missing data fails closed', () => {
  it('refuses an uninspectable PCZT', () => {
    expect(codes(verify(null))).toEqual(['pczt_unparseable']);
    expect(codes(verify('garbage'))).toEqual(['pczt_unparseable']);
  });

  it('refuses without a recomputed sighash', () => {
    expect(codes(verify(honest({ computed_sighash_hex: null })))).toEqual(['sighash_unavailable']);
  });

  it('refuses output from the currently vendored wasm (no committed fields)', () => {
    // Exactly the shape frost_inspect_pczt_outputs returns today.
    const legacy = {
      actions: [
        {
          index: 0,
          amount_zat: 600_000,
          recipient_raw_hex: RECIPIENT_RAW,
          is_change: false,
          decrypted: true,
        },
      ],
      summary: {
        total_send_zat: 600_000,
        total_change_zat: 0,
        decrypted_count: 1,
        action_count: 1,
      },
      computed_sighash_hex: SIGHASH,
    };
    const v = verify(legacy);
    expect(v.ok).toBe(false);
    expect(codes(v)).toEqual(['missing_field']);
  });

  it('refuses when the committed view could not be built', () => {
    expect(codes(verify(honest({ committed_outputs_error: 'Parse(...)' })))).toEqual([
      'committed_view_unavailable',
    ]);
  });

  it.each([
    'fee_zat',
    'expiry_height',
    'sapling_present',
    'transparent_input_count',
    'transparent_outputs',
  ])('refuses when %s is absent', field => {
    const p = honest() as unknown as Record<string, unknown>;
    delete p[field];
    const v = verify(p);
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain('missing_field');
  });

  it('refuses an output whose value does not verify against its cmx', () => {
    const v = verify(
      honest({
        actions: [
          action(0, RECIPIENT_RAW, 600_000, null),
          {
            ...action(1, CHANGE_RAW, 390_000, 'internal', true),
            cmx_verified: false,
            committed_value_zat: null,
          },
        ],
      }),
    );
    expect(codes(v)).toEqual(['output_unverifiable']);
  });

  it('refuses sapling components and transparent inputs', () => {
    expect(codes(verify(honest({ sapling_present: true })))).toEqual(['sapling_present']);
    expect(codes(verify(honest({ transparent_input_count: 1 })))).toEqual([
      'transparent_input_present',
    ]);
  });

  it('refuses a malformed intent', () => {
    expect(codes(verify(honest(), intent({ outputs: [] })))).toEqual(['intent_invalid']);
    expect(
      codes(verify(honest(), intent({ outputs: [{ address: RECIPIENT_UA, amountZat: 0n }] }))),
    ).toEqual(['intent_invalid']);
    expect(
      codes(verify(honest(), intent({ outputs: [{ address: 'zs1nope', amountZat: 1n }] }))),
    ).toEqual(['intent_invalid']);
    expect(codes(verify(honest(), intent({ expiry: { minHeight: 10, maxHeight: 5 } })))).toEqual([
      'intent_invalid',
    ]);
    expect(codes(verify(honest(), intent({ feeCapZat: -1n })))).toEqual(['intent_invalid']);
  });
});
