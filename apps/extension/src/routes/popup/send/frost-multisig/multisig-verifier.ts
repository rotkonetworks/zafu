// Multisig verifier - verdict computation. Compares the host's claimed
// (recipient, amount, fee) against the OVK-decrypted output the joiner
// derived locally from the PCZT the host published.
//
// There is deliberately NO "unverified but signable" verdict.
//
// The original reason was that the relay was unauthenticated and the room code
// guessable, so "the host" was anyone who could post. That is no longer true - // frostd admits only listed keys and Noise_K authenticates the sender - and
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
// Outputs are judged by the COMMITTED view, not by OVK decryption: each
// action's value and recipient recomputed against the cmx the sighash binds.
// OVK decryption is the host's to choose - an output it encrypts to a throwaway
// OVK simply does not decrypt - so treating undecryptable actions as zero-value
// dummies let a second, unseen payment ride along with an honest-looking one.
// The fee is the one the value balances (bound by the sighash) imply, and must
// be the fee the host claims; assessClaimedFee() bounds that claim.

import { encodeOrchardUnifiedAddress } from '@repo/wallet/networks/zcash/unified-address';
import type { FrostParsedTx } from '../../../../state/keyring/network-worker';

export type Verdict =
  | { kind: 'match'; sendZat: bigint; changeZat: bigint }
  | {
      kind: 'mismatch';
      reasons: string[];
      sendZat: bigint;
      changeZat: bigint;
    }
  | { kind: 'pending' }
  /** cannot verify - hard block, not overridable. */
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

const isSafeZat = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

interface CommittedOutput {
  index: number;
  valueZat: bigint;
  recipientRawHex: string;
  /** the inspecting UFVK's scope the recipient derives from; null = foreign */
  scope: 'external' | 'internal' | null;
  decrypted: boolean;
  isChange: boolean;
}

/**
 * Every value-carrying output, as committed, and the fee the value balances
 * imply - or why the transaction cannot be judged that way. Anything missing
 * refuses: a wasm too old to report the committed view must not fall back to
 * the OVK view the host controls.
 */
function committedView(
  parsed: FrostParsedTx,
): { outputs: CommittedOutput[]; feeZat: bigint } | { refuse: string[] } {
  const why = (...r: string[]) => ({ refuse: r });
  if (!('committed_outputs_error' in parsed)) {
    return why('the inspection does not report committed outputs - refusing on an older verifier');
  }
  if (parsed.committed_outputs_error !== null) {
    return why(
      `outputs could not be checked against their commitments: ${String(parsed.committed_outputs_error)}`,
    );
  }
  if (parsed.sapling_present !== false) {
    return why('the transaction has a sapling component, which a group spend never has');
  }
  if (parsed.transparent_input_count !== 0) {
    return why('the transaction spends transparent inputs, which a group spend never does');
  }
  if (!Array.isArray(parsed.transparent_outputs) || parsed.transparent_outputs.length > 0) {
    return why(
      'the transaction pays a transparent output, which this review cannot match to the claim',
    );
  }
  if (!isSafeZat(parsed.fee_zat)) {
    return why('the fee could not be derived from the value balances');
  }
  const outputs: CommittedOutput[] = [];
  for (const a of parsed.actions) {
    const raw = a.committed_recipient_raw_hex;
    const scope = a.recipient_scope;
    if (
      a.cmx_verified !== true ||
      !isSafeZat(a.committed_value_zat) ||
      typeof raw !== 'string' ||
      !/^[0-9a-fA-F]{86}$/.test(raw) ||
      !(scope === 'external' || scope === 'internal' || scope === null)
    ) {
      return why(`action ${a.index}: its output does not verify against its commitment`);
    }
    if (a.committed_value_zat > 0) {
      outputs.push({
        index: a.index,
        valueZat: BigInt(a.committed_value_zat),
        recipientRawHex: raw,
        scope,
        decrypted: a.decrypted,
        isChange: a.is_change,
      });
    }
  }
  return { outputs, feeZat: BigInt(parsed.fee_zat) };
}

/**
 * Build verdict from host's SIGN: claim and the joiner's locally-derived parse.
 *
 * For a single-recipient spend (the only shape today), judged on the
 * committed view:
 *   - exactly one value-carrying output that is not the group's own change,
 *     whose recipient matches `claimedRecipient` and amount `claimedAmountZat`
 *   - any number of change outputs to the group's own internal scope
 *   - no value-carrying output the group's viewing key cannot read
 *   - the fee the transaction pays equals `claimedFeeZat`
 */
export function computeVerdict(args: {
  parsed: FrostParsedTx;
  claimedRecipient: string;
  claimedAmountZat: string;
  claimedFeeZat: string;
  claimedSighashHex: string;
  mainnet: boolean;
}): Verdict {
  const { parsed, claimedRecipient, claimedAmountZat, claimedFeeZat, claimedSighashHex, mainnet } =
    args;
  const reasons: string[] = [];

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
        'sighash could not be recomputed from the published bytes - refusing to sign an unverifiable tx',
        'this tx has a transparent or sapling component, which this verifier cannot bind; a host can induce this deliberately',
      ],
    };
  }
  {
    const expected = parsed.computed_sighash_hex.toLowerCase();
    const claimed = claimedSighashHex.toLowerCase();
    if (expected !== claimed) {
      // a share over bytes nobody here inspected: never overridable
      return {
        kind: 'refuse',
        reasons: [
          'claimed sighash does not match the unsigned tx bytes - host is asking you to sign a different tx than the one shown',
          `claimed ${claimed.slice(0, 12)}…, derived ${expected.slice(0, 12)}…`,
        ],
      };
    }
  }

  const view = committedView(parsed);
  if ('refuse' in view) {
    return { kind: 'refuse', reasons: view.refuse };
  }

  // an output that carries value but that the group's viewing key cannot read
  // was hidden from this review on purpose: no honest build makes one
  const hidden = view.outputs.filter(o => !o.decrypted);
  if (hidden.length > 0) {
    return {
      kind: 'refuse',
      reasons: hidden.map(
        o =>
          `action ${o.index}: an output of ${o.valueZat} zat is hidden from the group's viewing key - the host is sending it somewhere unshown`,
      ),
    };
  }
  // change is a key-derivation fact (the group's internal scope), never the label
  const foreignChange = view.outputs.filter(o => o.isChange && o.scope !== 'internal');
  if (foreignChange.length > 0) {
    return {
      kind: 'refuse',
      reasons: foreignChange.map(
        o =>
          `action ${o.index}: ${o.valueZat} zat presented as change goes to an address that is not the group's`,
      ),
    };
  }

  // the fee is what the sighash-bound value balances leave over, not a claim
  const claimedFee = (() => {
    try {
      return BigInt(claimedFeeZat);
    } catch {
      return null;
    }
  })();
  if (claimedFee === null || claimedFee !== view.feeZat) {
    return {
      kind: 'refuse',
      reasons: [
        `the transaction pays a fee of ${view.feeZat} zat, not the ${claimedFeeZat} zat the host claims - the difference would leave the group unseen`,
      ],
    };
  }

  const externals = view.outputs.filter(o => o.scope !== 'internal');
  const changes = view.outputs.filter(o => o.scope === 'internal');
  const sendZat = externals.reduce((acc, o) => acc + o.valueZat, 0n);
  const changeZat = changes.reduce((acc, o) => acc + o.valueZat, 0n);

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
      `bundle has ${externals.length} recipient outputs but host's claim shows only one - possible split-spend attack`,
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
    externals.every(o => {
      try {
        const ua = encodeOrchardUnifiedAddress(hexToBytes(o.recipientRawHex), mainnet);
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
 * `frost_inspect_pczt_outputs` does not return it - it returns only the
 * OVK-decryptable outputs. We can therefore see what is being *sent* but never
 * what is being *spent*, so value conservation (inputs − outputs = fee) is not
 * checkable on this side of the wasm boundary at all.
 *
 * Concretely, the attack this does NOT stop: spend a 10 ZEC note, pay 0.01 to
 * the displayed recipient, emit no change, and let 9.99 fall out as fee for a
 * colluding miner. Every output-side check above passes - the recipient and
 * amount are exactly what was claimed - and the host simply claims a small fee
 * here. The fee we are bounding is an attacker-supplied string.
 *
 * What this does buy: it catches an *honestly reported* excessive fee (a broken
 * host, a fat-fingered coordinator, or an attacker who did not bother to lie in
 * this field), and it keeps the number off the "verified" side of the UI. Real
 * value-conservation needs `value_balance` plumbed through
 * `frost_inspect_pczt_outputs` in crates/zcash-wasm/src/frost.rs (the zcli
 * repo); the wasm ships here prebuilt, so it cannot be done from this repo.
 */
export const MAX_PLAUSIBLE_FEE_ZAT = 10_000_000n; // 0.1 ZEC - orders of magnitude above ZIP-317

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
 * to sign to the one recomputed from the PCZT (mandatory - escrow payouts are
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
      reasons: ['PCZT sighash could not be recomputed - refusing to sign an unverifiable payout'],
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

  // the payout is judged as committed, like a group spend (see computeVerdict):
  // the escrow is a co-signer too, and could hide an output from the OVK view
  const view = committedView(parsed);
  if ('refuse' in view) {
    return { kind: 'refuse', reasons: view.refuse };
  }
  const hidden = view.outputs.filter(o => !o.decrypted);
  if (hidden.length > 0) {
    return {
      kind: 'refuse',
      reasons: hidden.map(
        o =>
          `action ${o.index}: an output of ${o.valueZat} zat is hidden from the group's viewing key`,
      ),
    };
  }
  if (view.outputs.some(o => o.isChange && o.scope !== 'internal')) {
    return {
      kind: 'refuse',
      reasons: ["an output presented as change goes to an address that is not the group's"],
    };
  }
  if (view.feeZat > MAX_PLAUSIBLE_FEE_ZAT) {
    return {
      kind: 'refuse',
      reasons: [
        `the payout pays a fee of ${view.feeZat} zat, above the ${MAX_PLAUSIBLE_FEE_ZAT} zat bound`,
      ],
    };
  }

  const externals = view.outputs.filter(o => o.scope !== 'internal');
  const changes = view.outputs.filter(o => o.scope === 'internal');
  if (externals.length === 0) {
    return { kind: 'refuse', reasons: ['PCZT has no recipient output'] };
  }

  const outputs: { recipientUa: string; amountZat: bigint }[] = [];
  for (const o of externals) {
    try {
      outputs.push({
        recipientUa: encodeOrchardUnifiedAddress(hexToBytes(o.recipientRawHex), mainnet),
        amountZat: o.valueZat,
      });
    } catch {
      return { kind: 'refuse', reasons: ['a recipient output could not be decoded - refusing'] };
    }
  }

  const sendZat = outputs.reduce((acc, o) => acc + o.amountZat, 0n);
  const changeZat = changes.reduce((acc, o) => acc + o.valueZat, 0n);
  // a small payout must not be eaten as fee (the same rule as assessClaimedFee)
  if (view.feeZat > sendZat) {
    return {
      kind: 'refuse',
      reasons: [
        `the payout pays a fee of ${view.feeZat} zat, more than the ${sendZat} zat it sends`,
      ],
    };
  }
  return { kind: 'ok', outputs, sendZat, changeZat };
}

// ── sealed intent verification ──────────────────────────────────────────────
//
// For async group payments: members pre-approve an intent, the PCZT is built
// fresh at quorum, and a device releases its share only if the PCZT matches
// what was sealed. `verifySealedIntent` is that check, as a pure function.
//
// Like computeVerdict, it is built on the COMMITTED output view (value +
// recipient recomputed against each action's sighash-bound cmx), not on OVK
// decryption: an output the host encrypts to a throwaway OVK is invisible to
// OVK decryption. With every output's committed value known, and the fee taken
// from the value balance the sighash binds, nothing can move that the intent
// does not name. An inspection without those fields refuses
// (`missing_field` / `committed_view_unavailable`), never guesses.

/** One payment the group approved. */
export interface SealedIntentOutput {
  /**
   * Recipient, canonicalised at seal time: an orchard-only unified address
   * (`u1…` / `utest1…`, exactly what encodeOrchardUnifiedAddress produces) or a
   * transparent address (`t1…` / `t3…` / `tm…` / `t2…`). A multi-receiver UA
   * never matches and so is refused, never approximated.
   */
  address: string;
  /** exact value, in zatoshis, > 0 */
  amountZat: bigint;
}

/** What the group sealed. Every field is binding. */
export interface SealedIntent {
  /** identifies the group wallet whose UFVK the PCZT was inspected with */
  groupId: string;
  /** the complete set of payments; nothing else may leave the group */
  outputs: SealedIntentOutput[];
  /** the fee may be at most this */
  feeCapZat: bigint;
  /** inclusive bounds on the PCZT's nExpiryHeight */
  expiry: { minHeight: number; maxHeight: number };
  mainnet: boolean;
}

export type IntentRejectCode =
  /** the intent itself is malformed */
  | 'intent_invalid'
  /** the intent is for a different group than the one inspecting */
  | 'group_mismatch'
  /** no inspection result (the PCZT did not parse / inspect) */
  | 'pczt_unparseable'
  /** a field the check depends on is absent or ill-typed */
  | 'missing_field'
  | 'sighash_unavailable'
  | 'sighash_mismatch'
  /** the committed per-output view could not be produced */
  | 'committed_view_unavailable'
  /** an action's output value/recipient does not verify against its cmx */
  | 'output_unverifiable'
  | 'sapling_present'
  | 'transparent_input_present'
  /** value goes somewhere the intent does not name */
  | 'unexpected_output'
  /** value goes to a recipient in the intent, but not the sealed amount */
  | 'amount_mismatch'
  /** an output that presents as change (internal-OVK) pays a foreign address */
  | 'change_to_foreign_address'
  /** a sealed payment is not in the PCZT */
  | 'recipient_missing'
  | 'fee_unavailable'
  | 'fee_over_cap'
  | 'expiry_unavailable'
  | 'expiry_out_of_bounds';

export interface IntentRejectReason {
  code: IntentRejectCode;
  detail: string;
}

export type IntentVerdict =
  | {
      ok: true;
      /** the sighash to sign: recomputed from the PCZT, never a claim */
      sighashHex: string;
      feeZat: bigint;
      /** total returned to the group's own internal (change) addresses */
      changeZat: bigint;
      expiryHeight: number;
    }
  | { ok: false; reasons: IntentRejectReason[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const safeZat = (v: unknown): bigint | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;

const isHex = (v: unknown, bytes: number): v is string =>
  typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(v);

const SHIELDED_UA = /^(u1|utest1)[02-9ac-hj-np-z]+$/;
const TRANSPARENT_ADDR = /^t[1-9A-HJ-NP-Za-km-z]{20,60}$/;

type AddrKind = 'shielded' | 'transparent';
const addrKind = (address: string): AddrKind | null => {
  const a = address.trim();
  if (SHIELDED_UA.test(a.toLowerCase()) && (a === a.toLowerCase() || a === a.toUpperCase())) {
    return 'shielded';
  }
  if (TRANSPARENT_ADDR.test(a)) {
    return 'transparent';
  }
  return null;
};

/** canonical comparison form: bech32m is case-insensitive, base58 is not */
const canonAddr = (address: string, kind: AddrKind): string =>
  kind === 'shielded' ? address.trim().toLowerCase() : address.trim();

const reject = (code: IntentRejectCode, detail: string): IntentVerdict => ({
  ok: false,
  reasons: [{ code, detail }],
});

function checkIntent(intent: SealedIntent): IntentRejectReason | null {
  const bad = (detail: string): IntentRejectReason => ({ code: 'intent_invalid', detail });
  if (!intent.groupId) {
    return bad('intent has no group id');
  }
  if (!Array.isArray(intent.outputs) || intent.outputs.length === 0) {
    return bad('intent names no payments');
  }
  for (const o of intent.outputs) {
    if (typeof o.amountZat !== 'bigint' || o.amountZat <= 0n) {
      return bad('every sealed payment must be a positive amount');
    }
    if (typeof o.address !== 'string' || addrKind(o.address) === null) {
      return bad('a sealed recipient is not an orchard-only unified or transparent address');
    }
  }
  if (typeof intent.feeCapZat !== 'bigint' || intent.feeCapZat < 0n) {
    return bad('fee cap must be a non-negative amount');
  }
  const { minHeight, maxHeight } = intent.expiry ?? {};
  if (
    !Number.isSafeInteger(minHeight) ||
    !Number.isSafeInteger(maxHeight) ||
    minHeight <= 0 ||
    minHeight > maxHeight
  ) {
    return bad('expiry bounds must be positive heights with min <= max');
  }
  return null;
}

/**
 * Decide whether a PCZT is exactly the payment a group sealed.
 *
 * `parsed` is the joiner's own frost_inspect_pczt_outputs result for the
 * PCZT, produced with the UFVK of the group identified by `localGroupId`
 * (`null` if inspection threw). `claimedSighashHex`, when a coordinator sent
 * one, must equal the sighash recomputed from the PCZT.
 *
 * Returns ok only when ALL of the following hold, else every reason found:
 *   - the sighash is recomputable (and equals the claim, if any);
 *   - every action's output value + recipient verify against its cmx;
 *   - each sealed payment is paid exactly once, to that address, that amount;
 *   - every other non-zero output pays the group's own internal (change) scope;
 *   - no sapling component, no transparent inputs, and every transparent
 *     output is a sealed payment;
 *   - fee (from the sighash-bound value balances) <= the sealed cap;
 *   - nExpiryHeight is non-zero and within the sealed bounds.
 */
export function verifySealedIntent(args: {
  parsed: unknown;
  intent: SealedIntent;
  localGroupId: string;
  claimedSighashHex?: string;
}): IntentVerdict {
  const { parsed, intent, localGroupId, claimedSighashHex } = args;

  const intentProblem = checkIntent(intent);
  if (intentProblem) {
    return { ok: false, reasons: [intentProblem] };
  }
  if (intent.groupId !== localGroupId) {
    return reject('group_mismatch', 'this intent was sealed for a different group');
  }
  if (!isRecord(parsed)) {
    return reject('pczt_unparseable', 'the PCZT could not be inspected');
  }

  // ── sighash: the only thing binding a share to these bytes ──
  const sighash = parsed['computed_sighash_hex'];
  if (!isHex(sighash, 32)) {
    return reject('sighash_unavailable', 'the sighash could not be recomputed from the PCZT');
  }
  if (
    claimedSighashHex !== undefined &&
    claimedSighashHex.toLowerCase() !== sighash.toLowerCase()
  ) {
    return reject('sighash_mismatch', 'the coordinator asked to sign a different transaction');
  }

  // ── committed view must exist before anything else can be judged ──
  if (!('committed_outputs_error' in parsed)) {
    return reject('missing_field', 'committed_outputs_error (inspection wasm too old)');
  }
  if (parsed['committed_outputs_error'] !== null) {
    return reject(
      'committed_view_unavailable',
      `committed outputs could not be read: ${String(parsed['committed_outputs_error'])}`,
    );
  }

  const reasons: IntentRejectReason[] = [];
  const push = (code: IntentRejectCode, detail: string) => reasons.push({ code, detail });

  // ── transaction-level fields ──
  const sapling = parsed['sapling_present'];
  if (typeof sapling !== 'boolean') {
    push('missing_field', 'sapling_present');
  } else if (sapling) {
    push('sapling_present', 'the transaction has a sapling component');
  }

  const tInCount = parsed['transparent_input_count'];
  if (typeof tInCount !== 'number' || !Number.isSafeInteger(tInCount) || tInCount < 0) {
    push('missing_field', 'transparent_input_count');
  } else if (tInCount > 0) {
    push('transparent_input_present', `${tInCount} transparent input(s) in a shielded group spend`);
  }

  const tOuts = parsed['transparent_outputs'];
  if (!Array.isArray(tOuts)) {
    push('missing_field', 'transparent_outputs');
  }

  const fee = safeZat(parsed['fee_zat']);
  if (!('fee_zat' in parsed)) {
    push('missing_field', 'fee_zat');
  } else if (fee === null) {
    push('fee_unavailable', 'the fee could not be derived from the value balances');
  } else if (fee > intent.feeCapZat) {
    push('fee_over_cap', `fee ${fee} zat exceeds the sealed cap of ${intent.feeCapZat} zat`);
  }

  const expiry = parsed['expiry_height'];
  let expiryHeight = 0;
  if (!('expiry_height' in parsed)) {
    push('missing_field', 'expiry_height');
  } else if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry <= 0) {
    push('expiry_unavailable', 'the transaction has no usable expiry height (0 = never expires)');
  } else if (expiry < intent.expiry.minHeight || expiry > intent.expiry.maxHeight) {
    push(
      'expiry_out_of_bounds',
      `expiry height ${expiry} is outside the sealed ${intent.expiry.minHeight}..${intent.expiry.maxHeight}`,
    );
  } else {
    expiryHeight = expiry;
  }

  // ── outputs: every value-carrying output must be named or be our change ──
  const remaining = intent.outputs.map(o => {
    const kind = addrKind(o.address)!;
    return { kind, address: canonAddr(o.address, kind), amountZat: o.amountZat, paid: false };
  });
  const claim = (
    kind: AddrKind,
    address: string,
    value: bigint,
  ): 'paid' | 'wrong_amount' | 'none' => {
    const exact = remaining.find(
      r => !r.paid && r.kind === kind && r.address === address && r.amountZat === value,
    );
    if (exact) {
      exact.paid = true;
      return 'paid';
    }
    return remaining.some(r => r.kind === kind && r.address === address) ? 'wrong_amount' : 'none';
  };

  const actions = parsed['actions'];
  let changeZat = 0n;
  if (!Array.isArray(actions)) {
    push('missing_field', 'actions');
  } else {
    for (const a of actions as unknown[]) {
      if (!isRecord(a)) {
        push('missing_field', 'action entry');
        continue;
      }
      const where = `${String(a['pool'] ?? '?')} action ${String(a['index'] ?? '?')}`;
      if (!('cmx_verified' in a) || !('committed_value_zat' in a) || !('recipient_scope' in a)) {
        push('missing_field', `${where}: committed output fields`);
        continue;
      }
      const value = safeZat(a['committed_value_zat']);
      const raw = a['committed_recipient_raw_hex'];
      if (a['cmx_verified'] !== true || value === null || !isHex(raw, 43)) {
        push('output_unverifiable', `${where}: output does not verify against its commitment`);
        continue;
      }
      if (value === 0n) {
        continue; // zero-value (dummy) output: moves nothing, whoever it is addressed to
      }
      let ua: string;
      try {
        ua = canonAddr(encodeOrchardUnifiedAddress(hexToBytes(raw), intent.mainnet), 'shielded');
      } catch {
        push('output_unverifiable', `${where}: recipient does not encode`);
        continue;
      }
      const hit = claim('shielded', ua, value);
      if (hit === 'paid') {
        continue;
      }
      const scope = a['recipient_scope'];
      if (hit === 'none' && scope === 'internal') {
        changeZat += value;
        continue;
      }
      if (hit === 'wrong_amount') {
        push(
          'amount_mismatch',
          `${where}: pays a sealed recipient ${value} zat, not the sealed amount`,
        );
      } else if (scope === null && a['is_change'] === true) {
        push(
          'change_to_foreign_address',
          `${where}: change of ${value} zat goes to a foreign address`,
        );
      } else {
        push('unexpected_output', `${where}: ${value} zat to an address the intent does not name`);
      }
    }
  }

  if (Array.isArray(tOuts)) {
    (tOuts as unknown[]).forEach((o, i) => {
      const where = `transparent output ${i}`;
      if (!isRecord(o)) {
        push('missing_field', where);
        return;
      }
      const value = safeZat(o['value_zat']);
      const address = o['address'];
      if (value === null || typeof address !== 'string') {
        push('unexpected_output', `${where}: non-standard script or unreadable value`);
        return;
      }
      const hit = claim('transparent', canonAddr(address, 'transparent'), value);
      if (hit === 'wrong_amount') {
        push(
          'amount_mismatch',
          `${where}: pays a sealed recipient ${value} zat, not the sealed amount`,
        );
      } else if (hit === 'none') {
        push('unexpected_output', `${where}: ${value} zat to an address the intent does not name`);
      }
    });
  }

  for (const r of remaining) {
    if (!r.paid) {
      push('recipient_missing', `sealed payment of ${r.amountZat} zat is not in the transaction`);
    }
  }

  if (reasons.length > 0 || fee === null) {
    return { ok: false, reasons };
  }
  return { ok: true, sighashHex: sighash.toLowerCase(), feeZat: fee, changeZat, expiryHeight };
}
