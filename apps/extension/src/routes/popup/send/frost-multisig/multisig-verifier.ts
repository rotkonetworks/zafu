// Multisig verifier — verdict computation. Compares the host's claimed
// (recipient, amount, fee) against the OVK-decrypted output the joiner
// derived locally from the unsigned tx bytes. Mismatch → joiner refuses
// to sign. Missing unsignedTx / missing UFVK → fall back to host-claim
// with a yellow warning.

import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';

export type Verdict =
  | { kind: 'match'; sendZat: bigint; changeZat: bigint }
  | { kind: 'mismatch'; reasons: string[]; sendZat: bigint; changeZat: bigint; sighashLie?: boolean }
  | { kind: 'pending' }
  | { kind: 'unverified'; reason: string };

const hexToBytes = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const normaliseAddr = (a: string) => a.trim().toLowerCase();

/**
 * Build verdict from host's SIGN: claim and the joiner's locally-derived parse.
 *
 * For a single-recipient spend (the only shape today):
 *   - exactly one external (non-change) action whose recipient matches
 *     `claimedRecipient` and amount matches `claimedAmountZat`
 *   - any number of internal change actions
 *   - any non-decrypted actions are treated as zero-value dummies
 */
export function computeVerdict(args: {
  parsed: FrostParsedTx;
  claimedRecipient: string;
  claimedAmountZat: string;
  claimedSighashHex: string;
  mainnet: boolean;
}): Verdict {
  const { parsed, claimedRecipient, claimedAmountZat, claimedSighashHex, mainnet } = args;
  const reasons: string[] = [];

  const externals = parsed.actions.filter(a => a.decrypted && !a.is_change);
  const changes = parsed.actions.filter(a => a.decrypted && a.is_change);

  const sendZat = externals.reduce((acc, a) => acc + BigInt(a.amount_zat), 0n);
  const changeZat = changes.reduce((acc, a) => acc + BigInt(a.amount_zat), 0n);

  // Sighash check first — if the host published an honest sighash but a
  // decoy bundle, OVK decryption can return a "matching" parse for an
  // entirely different tx than the one being signed. The sighash binds
  // shares to the actual message; verifying it agrees with what the
  // bundle bytes hash to closes that gap.
  if (parsed.computed_sighash_hex) {
    const expected = parsed.computed_sighash_hex.toLowerCase();
    const claimed = claimedSighashHex.toLowerCase();
    if (expected !== claimed) {
      return {
        kind: 'mismatch',
        sighashLie: true,
        sendZat,
        changeZat,
        reasons: [
          'claimed sighash does not match the unsigned tx bytes — host is asking you to sign a different tx than the one shown',
          `claimed ${claimed.slice(0, 12)}…, derived ${expected.slice(0, 12)}…`,
        ],
      };
    }
  }

  const claimedAmount = (() => {
    try { return BigInt(claimedAmountZat); }
    catch { return null; }
  })();

  if (claimedAmount === null) {
    return { kind: 'mismatch', reasons: ['claimed amount not a number'], sendZat, changeZat };
  }

  // Reject split-spend: the host's SIGN: payload claims a single
  // (recipient, amount). The build path only ever produces one external
  // output. Multiple externals = the host is silently sending part of
  // the funds elsewhere on top of the displayed recipient.
  if (externals.length > 1) {
    reasons.push(
      `bundle has ${externals.length} recipient outputs but host's claim shows only one — possible split-spend attack`,
    );
  } else if (externals.length === 0 && claimedAmount > 0n) {
    reasons.push('bundle has no recipient output but host claims to send funds');
  }

  if (sendZat !== claimedAmount) {
    reasons.push(
      `claimed ${claimedAmount} zat sent, derived ${sendZat} zat across ${externals.length} recipient${externals.length === 1 ? '' : 's'}`,
    );
  }

  // Recipient address must match exactly. With externals.length === 1
  // (enforced above), this is a precise check, not a permissive `some`.
  const claimedNorm = normaliseAddr(claimedRecipient);
  const matched = externals.length === 1 && externals.every(a => {
    if (!a.recipient_raw_hex) return false;
    try {
      const ua = encodeOrchardUnifiedAddress(hexToBytes(a.recipient_raw_hex), mainnet);
      return normaliseAddr(ua) === claimedNorm;
    } catch {
      return false;
    }
  });
  if (!matched && externals.length === 1) {
    reasons.push('claimed recipient does not match the derived output');
  }

  if (reasons.length > 0) {
    return { kind: 'mismatch', reasons, sendZat, changeZat };
  }
  // If we couldn't compute the sighash (transparent/sapling component
  // present), surface that to the caller so the UI can warn rather than
  // silently treating "OVK-decryption matches" as full proof.
  if (!parsed.computed_sighash_hex) {
    return {
      kind: 'unverified',
      reason: 'tx has transparent/sapling component — sighash check skipped, OVK decode matched only',
    };
  }
  return { kind: 'match', sendZat, changeZat };
}
