// Multisig verifier — verdict computation. Compares the host's claimed
// (recipient, amount, fee) against the OVK-decrypted output the joiner
// derived locally from the PCZT the host published.
//
// There is deliberately NO "unverified but signable" verdict.
//
// The original reason was that the relay was unauthenticated and the room code
// guessable, so "the host" was anyone who could post. That is no longer true —
// frostd admits only listed keys and Noise_K authenticates the sender — and
// the rule stands anyway, on the reason that does not expire: the host is a
// co-signer, and a threshold scheme exists precisely because a co-signer is
// not fully trusted. Authenticating who sent a claim says nothing about
// whether the claim is honest.
//
// A state that fails to verify yet leaves the approve button live is a
// downgrade attack, not a compatibility affordance. Every
// path that cannot establish (recipient, amount, sighash) from bytes returns
// `refuse`, which no UI may override. This matches computeEscrowVerdict below,
// which already worked this way.
//
// RESIDUAL — the fee is NOT verified. See assessClaimedFee().

import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';

export type Verdict =
  | { kind: 'match'; sendZat: bigint; changeZat: bigint }
  | {
      kind: 'mismatch';
      reasons: string[];
      sendZat: bigint;
      changeZat: bigint;
      sighashLie?: boolean;
    }
  | { kind: 'pending' }
  /** cannot verify — hard block, not overridable. */
  | { kind: 'refuse'; reasons: string[] };

/** true for the verdicts a signer is permitted to release a share against. */
export const verdictAllowsSigning = (v: Verdict, acknowledgedMismatch: boolean): boolean =>
  v.kind === 'match' || (v.kind === 'mismatch' && acknowledgedMismatch);

const hexToBytes = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
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

  // Sighash check first, and it is MANDATORY. If the host published an honest
  // sighash but a decoy bundle, OVK decryption can return a "matching" parse
  // for an entirely different tx than the one being signed. The sighash is the
  // only thing that binds our share to the actual message, so without it the
  // OVK decode proves nothing about what we are signing.
  //
  // This must not degrade to a warning: a host can *choose* to make the sighash
  // unrecomputable simply by adding a dust transparent output (the parser
  // returns null for any tx with a transparent/sapling component). A downgrade
  // the attacker controls is not a downgrade, it is a bypass.
  if (!parsed.computed_sighash_hex) {
    return {
      kind: 'refuse',
      reasons: [
        'sighash could not be recomputed from the published bytes — refusing to sign an unverifiable tx',
        'this tx has a transparent or sapling component, which this verifier cannot bind; a host can induce this deliberately',
      ],
    };
  }
  {
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
    try {
      return BigInt(claimedAmountZat);
    } catch {
      return null;
    }
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
  const matched =
    externals.length === 1 &&
    externals.every(a => {
      if (!a.recipient_raw_hex) {
        return false;
      }
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
  return { kind: 'match', sendZat, changeZat };
}

/**
 * Sanity bound on the host's CLAIMED fee.
 *
 * READ THIS BEFORE TRUSTING IT. This is not fee verification and cannot be.
 * For a shielded-only tx the fee IS `orchard_bundle.value_balance()`, and
 * `frost_inspect_pczt_outputs` does not return it — it returns only the
 * OVK-decryptable outputs. We can therefore see what is being *sent* but never
 * what is being *spent*, so value conservation (inputs − outputs = fee) is not
 * checkable on this side of the wasm boundary at all.
 *
 * Concretely, the attack this does NOT stop: spend a 10 ZEC note, pay 0.01 to
 * the displayed recipient, emit no change, and let 9.99 fall out as fee for a
 * colluding miner. Every output-side check above passes — the recipient and
 * amount are exactly what was claimed — and the host simply claims a small fee
 * here. The fee we are bounding is an attacker-supplied string.
 *
 * What this does buy: it catches an *honestly reported* excessive fee (a broken
 * host, a fat-fingered coordinator, or an attacker who did not bother to lie in
 * this field), and it keeps the number off the "verified" side of the UI. Real
 * value-conservation needs `value_balance` plumbed through
 * `frost_inspect_pczt_outputs` in crates/zcash-wasm/src/frost.rs (the zcli
 * repo); the wasm ships here prebuilt, so it cannot be done from this repo.
 */
export const MAX_PLAUSIBLE_FEE_ZAT = 10_000_000n; // 0.1 ZEC — orders of magnitude above ZIP-317

export function assessClaimedFee(
  claimedFeeZat: string,
  claimedAmountZat: string,
): { ok: true } | { ok: false; reason: string } {
  let fee: bigint;
  let amount: bigint;
  try {
    fee = BigInt(claimedFeeZat || '0');
    amount = BigInt(claimedAmountZat || '0');
  } catch {
    return { ok: false, reason: 'claimed fee is not a number' };
  }
  if (fee < 0n) {
    return { ok: false, reason: 'claimed fee is negative' };
  }
  if (fee > MAX_PLAUSIBLE_FEE_ZAT) {
    return {
      ok: false,
      reason: `claimed fee ${fee} zat exceeds the ${MAX_PLAUSIBLE_FEE_ZAT} zat sanity bound`,
    };
  }
  if (amount > 0n && fee > amount) {
    return {
      ok: false,
      reason: `claimed fee ${fee} zat exceeds the amount being sent (${amount} zat)`,
    };
  }
  return { ok: true };
}

export type EscrowVerdict =
  | {
      kind: 'ok';
      outputs: { recipientUa: string; amountZat: bigint }[];
      sendZat: bigint;
      changeZat: bigint;
    }
  | { kind: 'refuse'; reasons: string[] };

/**
 * Verdict for an escrow-driven payout (poker, and future escrow multisig).
 * Unlike computeVerdict the dapp's claimed plan is NOT trusted: the escrow
 * builds the PCZT, so the PCZT is the only truth. Bind the sighash we're about
 * to sign to the one recomputed from the PCZT (mandatory — escrow payouts are
 * orchard-only so a null sighash means we can't verify), then return the
 * OVK-decoded outputs for the user to approve. Output-side parity with
 * computeVerdict; value-conservation against inputs needs data the parser
 * doesn't expose yet, same residual as the send-flow verifier (gh #17 follow-up).
 */
export function computeEscrowVerdict(args: {
  parsed: FrostParsedTx;
  claimedSighashHex: string;
  mainnet: boolean;
}): EscrowVerdict {
  const { parsed, claimedSighashHex, mainnet } = args;

  if (!parsed.computed_sighash_hex) {
    return {
      kind: 'refuse',
      reasons: ['PCZT sighash could not be recomputed — refusing to sign an unverifiable payout'],
    };
  }
  const expected = parsed.computed_sighash_hex.toLowerCase();
  const claimed = claimedSighashHex.toLowerCase();
  if (expected !== claimed) {
    return {
      kind: 'refuse',
      reasons: [
        'escrow asked you to sign a different tx than the PCZT shown',
        `signing ${claimed.slice(0, 12)}…, PCZT hashes to ${expected.slice(0, 12)}…`,
      ],
    };
  }

  const externals = parsed.actions.filter(a => a.decrypted && !a.is_change);
  const changes = parsed.actions.filter(a => a.decrypted && a.is_change);
  if (externals.length === 0) {
    return { kind: 'refuse', reasons: ['PCZT has no decodable recipient output'] };
  }

  const outputs: { recipientUa: string; amountZat: bigint }[] = [];
  for (const a of externals) {
    if (!a.recipient_raw_hex) {
      return { kind: 'refuse', reasons: ['a recipient output could not be decoded — refusing'] };
    }
    try {
      outputs.push({
        recipientUa: encodeOrchardUnifiedAddress(hexToBytes(a.recipient_raw_hex), mainnet),
        amountZat: BigInt(a.amount_zat),
      });
    } catch {
      return { kind: 'refuse', reasons: ['a recipient output could not be decoded — refusing'] };
    }
  }

  const sendZat = outputs.reduce((acc, o) => acc + o.amountZat, 0n);
  const changeZat = changes.reduce((acc, a) => acc + BigInt(a.amount_zat), 0n);
  return { kind: 'ok', outputs, sendZat, changeZat };
}
