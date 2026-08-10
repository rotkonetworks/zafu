/**
 * Voting delegation PCZT signing via zigner (air-gapped animated-QR).
 *
 * A voting delegation PCZT (from wasm `build_delegation_pczt`) is redacted and
 * routed through the SAME zigner signing path as shielded sends: the
 * `zcash-pczt` animated QR round-trip (NOT the ironwood `zigner-module` path).
 *
 * This module adapts the delegation context (redacted PCZT + sighash) into an
 * `ExternalSigner` request/result pair, bridging the voting flow to the
 * existing `AnimatedQrDisplay` + `AnimatedQrScanner` UI state machine.
 *
 * The voter's vote screen will:
 * 1. Call `votingDelegationSigner(ctx)` to build the signing request.
 * 2. Display the `request.pcztHex` as an animated `ur:zcash-pczt/` QR.
 * 3. Scan the zigner's `ur:zcash-pczt/` response (signed PCZT).
 * 4. Pass the scanned `SignResult` to `toResult()` to extract the delegation
 *    spend-auth signature and reconstruct the context for wasm `attach_delegation_sig`.
 *
 * Exactly ONE spend-auth signature is expected back (for the single delegation
 * action at `actionIndex`).
 */

import type { SignRequest, SignResult, SignerFilter } from './external-signer';

/**
 * Output of wasm `build_delegation_pczt`:
 * - `redactedPcztHex`: the redacted PCZT (zero'd fields for non-signing inputs),
 *   ready to send to the cold signer.
 * - `pcztSighashHex`: the sighash the device committed to when signing.
 * - `rkHex`: randomized verification key (for spend-auth sig verification).
 * - `actionIndex`: the orchard action index where the delegation signature goes.
 * - `mainnet`: whether this is mainnet (affects signature verification).
 */
export interface DelegationSignContext {
  redactedPcztHex: string;
  pcztSighashHex: string;
  rkHex: string;
  actionIndex: number;
  mainnet: boolean;
}

/**
 * Result after scanning the zigner's signed PCZT:
 * - `spendAuthSigHex`: the extracted 64-byte RedPallas spend-auth signature, hex.
 * - `sighashHex`: the sighash the device committed to (echoed back for verification).
 * - `actionIndex`: the delegation action index (for routing to `attach_delegation_sig`).
 *
 * This is fed to wasm `attach_delegation_sig` to merge the signature into the
 * full unsigned PCZT the voter retains.
 */
export interface DelegationSignResult {
  spendAuthSigHex: string;
  sighashHex: string;
  actionIndex: number;
}

/**
 * Build a signing request and result adapter for a delegation PCZT.
 *
 * Returns a pair:
 * - `request`: the `SignRequest` to hand to an `ExternalSigner` (e.g., zigner
 *   via AnimatedQrDisplay). Contains the redacted PCZT and identifies the
 *   single orchard action index that needs a spend-auth signature.
 * - `toResult`: a pure adapter that extracts the signature from the
 *   `SignResult` returned by the signer. Throws if the response is malformed
 *   (missing signature at the expected index).
 *
 * PURE ADAPTER: this function does NOT drive the UI itself. The vote screen
 * calls `AnimatedQrDisplay` / `AnimatedQrScanner` as usual, then hands the
 * scanned `SignResult` to `toResult()`.
 *
 * @param ctx Redacted PCZT context and delegation metadata from `build_delegation_pczt`.
 * @returns A signing request and result adapter.
 */
export function votingDelegationSigner(ctx: DelegationSignContext): {
  request: SignRequest;
  toResult: (sr: SignResult) => DelegationSignResult;
} {
  const request: SignRequest = {
    pcztHex: ctx.redactedPcztHex,
    spendIndices: [ctx.actionIndex],
    mainnet: ctx.mainnet,
  };

  const toResult = (sr: SignResult): DelegationSignResult => {
    // S2: select the signature by its action index rather than assuming slot 0.
    // `orchardSigs` is aligned 1:1 with `spendIndices`; find the position whose
    // spend index is our delegation action and take the matching signature.
    const pos = sr.spendIndices.findIndex(i => i === ctx.actionIndex);
    if (pos === -1) {
      throw new Error(
        `signer did not return a signature for delegation action ${ctx.actionIndex}; got indices [${sr.spendIndices.join(', ')}]`,
      );
    }
    const sig = sr.orchardSigs[pos];
    if (!sig) {
      throw new Error(`no spend-auth signature at position ${pos} for action ${ctx.actionIndex}`);
    }

    return {
      spendAuthSigHex: sig,
      sighashHex: ctx.pcztSighashHex,
      actionIndex: ctx.actionIndex,
    };
  };

  return { request, toResult };
}

/**
 * Composition helper: a `SignerFilter` that refuses to sign a delegation PCZT
 * unless the caller has verified the voting round.
 *
 * S1: this is a REAL gate, not a stub. The caller (the vote screen) already
 * knows whether the round is trustworthy - it must be present in the pinned
 * dynamic config (`round.inConfig`) AND pass the round's ed25519 authenticator
 * check - and passes that boolean in. If false, signing is refused before the
 * PCZT ever reaches the cold device.
 *
 * Defense in depth: the PRIMARY control remains the human reading the
 * `display_memo` ("delegate N ZEC for round X") on the air-gapped device before
 * approving. This filter is the in-app second line, guarding against a
 * socially-engineered flow that would otherwise present an unverified round.
 *
 * Compose as `compose(requireVotingRoundVerified(round.inConfig && authOk))(base)`.
 */
export const requireVotingRoundVerified =
  (roundVerified: boolean): SignerFilter =>
  next =>
  req => {
    if (!roundVerified) {
      return Promise.reject(
        new Error('refusing to sign delegation: voting round is not config-verified'),
      );
    }
    return next(req);
  };
