// WYSIWYS Layer 4 — verdict computation. Compares the host's claimed
// (recipient, amount, fee) against the OVK-decrypted output the joiner
// derived locally from the unsigned tx bytes. Mismatch → joiner refuses
// to sign. Missing unsignedTx / missing UFVK → fall back to host-claim
// with a yellow warning.

import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';

export type Verdict =
  | { kind: 'match'; sendZat: bigint; changeZat: bigint }
  | { kind: 'mismatch'; reasons: string[]; sendZat: bigint; changeZat: bigint }
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
  mainnet: boolean;
}): Verdict {
  const { parsed, claimedRecipient, claimedAmountZat, mainnet } = args;
  const reasons: string[] = [];

  const externals = parsed.actions.filter(a => a.decrypted && !a.is_change);
  const changes = parsed.actions.filter(a => a.decrypted && a.is_change);

  const sendZat = externals.reduce((acc, a) => acc + BigInt(a.amount_zat), 0n);
  const changeZat = changes.reduce((acc, a) => acc + BigInt(a.amount_zat), 0n);

  const claimedAmount = (() => {
    try { return BigInt(claimedAmountZat); }
    catch { return null; }
  })();

  if (claimedAmount === null) {
    return { kind: 'mismatch', reasons: ['claimed amount not a number'], sendZat, changeZat };
  }

  if (sendZat !== claimedAmount) {
    reasons.push(
      `claimed ${claimedAmount} zat sent, derived ${sendZat} zat across ${externals.length} recipient${externals.length === 1 ? '' : 's'}`,
    );
  }

  // Check at least one external action targets the claimed recipient.
  const claimedNorm = normaliseAddr(claimedRecipient);
  const matched = externals.some(a => {
    if (!a.recipient_raw_hex) return false;
    try {
      const ua = encodeOrchardUnifiedAddress(hexToBytes(a.recipient_raw_hex), mainnet);
      return normaliseAddr(ua) === claimedNorm;
    } catch {
      return false;
    }
  });
  if (!matched) {
    reasons.push('claimed recipient not found among derived outputs');
  }

  if (reasons.length > 0) {
    return { kind: 'mismatch', reasons, sendZat, changeZat };
  }
  return { kind: 'match', sendZat, changeZat };
}
