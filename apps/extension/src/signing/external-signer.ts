/**
 * External (cold) signers, "your server as a function" style.
 *
 * A cold signer - zigner (QR), Ledger (WebHID), keystone, ... - is the SAME
 * function: an unsigned PCZT in, the orchard spend-auth signatures out. We model
 * it as a `Service` (Marius Eriksen / Finagle): `ExternalSigner = SignRequest ->
 * Promise<SignResult>`. Cross-cutting concerns (feature-flag gate, device-app
 * version gate, tracing) are `SignerFilter`s that wrap a service into another
 * service and compose freely. The send flow then just picks a service and calls
 * it, instead of a per-transport branch cascade.
 *
 * The signatures returned here are injected into the (already proven + binding-
 * signed) PCZT via the wasm `complete_orchard_pczt` role - see the zcash worker.
 */

/** An unsigned PCZT handed to a cold signer. `pcztHex` is the standard pczt-crate
 *  serialization; `spendIndices` are the real-spend orchard action indices that
 *  still need a spend-auth signature (IoFinalizer already signed the dummies). */
export interface SignRequest {
  pcztHex: string;
  spendIndices: number[];
  mainnet: boolean;
}

/**
 * What a cold signer produces - a discriminated union on DELIVERY FORM, which is
 * the true axis the completion dispatches on (see cold-send.ts). Pool is NOT a
 * field: it is implied by the form. Raw spend-auth sigs are injected via the
 * orchard role - the only inject role that exists - so that form is orchard by
 * construction; a signed PCZT is extracted pool-agnostically, so it carries its
 * own pool. This is why there is no `pool` discriminant and no ironwood throw:
 * to complete an ironwood spend you MUST return `signedPczt`, which is simply a
 * different variant, not an illegal state.
 */
export type SignResult = InjectableSpendAuthSigs | SignedPczt;

/** Raw 64-byte RedPallas spend-auth signatures (hex), aligned 1:1 with
 *  `spendIndices`, for the host to INJECT via `complete_orchard_pczt`. The only
 *  inject role today is orchard, so this form is orchard by construction. */
export interface InjectableSpendAuthSigs {
  readonly kind: 'spendAuthSigs';
  readonly spendAuthSigs: string[];
  readonly spendIndices: number[];
}

/** A fully-signed PCZT (device-signed, or contributions merged in host-side) for
 *  the worker to EXTRACT + broadcast. Pool-agnostic - orchard or ironwood. */
export interface SignedPczt {
  readonly kind: 'signedPczt';
  readonly pcztHex: string;
}

/**
 * A cold signer: PCZT -> orchard spend-auth signatures.
 *
 * TWO TRANSPORT TOPOLOGIES fit this one type - naming them is the point, so we
 * never paper a suspended flow over with a synchronous mold:
 *
 *   - SYNCHRONOUS-AWAIT (Ledger WebHID, self-custody FROST rounds): the whole
 *     request->response happens inside the returned Promise. These drop straight
 *     into `signAndBroadcast` (cold-send.ts) today.
 *       * Ledger:  ledgerSignerFor(session)                (ledger-signer.ts)
 *       * FROST:   () => runMnemonicFrostSign({...})       (wrap the rounds)
 *
 *   - SUSPENDED (zigner QR, airgap FROST): the signature returns across a UI
 *     cycle - display an animated UR, the user carries it to an air-gapped
 *     device, signs, and scans the response back with the camera, possibly after
 *     the popup was torn down. To present these as an `ExternalSigner` the
 *     Promise must be a Deferred RESOLVED by the scan handler, not an inline
 *     await. Modelled but NOT yet migrated: the send component still drives these
 *     as an explicit two-phase flow (build+display, then a separate
 *     handlePcztSignatureScanned). Migrating them means threading that Deferred
 *     through the signing store; behaviour-preserving but it touches a working
 *     mainnet path, so it is a deliberate, separately-verified step.
 */
export type ExternalSigner = (req: SignRequest) => Promise<SignResult>;

/** A filter transforms one signer into another (feature-flag, version-gate,
 *  tracing, retry, ...). `Filter[in, out] = (next: Service) => Service`. */
export type SignerFilter = (next: ExternalSigner) => ExternalSigner;

/**
 * Compose filters onto a base signer, left-to-right in application order:
 *   compose(a, b)(base)  ==  a(b(base))
 * so the first-listed filter is the OUTERMOST (runs first on the way in). An
 * empty list is the identity filter.
 */
export function compose(...filters: SignerFilter[]): SignerFilter {
  return base => filters.reduceRight((next, filter) => filter(next), base);
}

/** Identity filter - useful as a default / no-op in conditional composition. */
export const identityFilter: SignerFilter = next => next;
