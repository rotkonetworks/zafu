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

/** Raw 64-byte RedPallas orchard spend-auth signatures (hex), aligned 1:1 with
 *  `spendIndices`. Ready for `complete_orchard_pczt(pcztHex, orchardSigs, spendIndices)`. */
export interface SignResult {
  orchardSigs: string[];
  spendIndices: number[];
}

/** A cold signer: PCZT -> orchard spend-auth signatures. */
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
