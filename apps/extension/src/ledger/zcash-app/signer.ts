/**
 * Ledger Zcash app as an `ExternalSigner` (../../signing/external-signer.ts).
 *
 * One device approval = one call:
 *
 *   protocol.validatePczt        reject over-limit / unsupported PCZTs BEFORE
 *                                anything reaches the device
 *   device.currentApp            open the Zcash app if needed, gate its version
 *   protocol.pcztSigningPlan     APDUs for this PCZT
 *   device.exchange              the only device I/O; the user reviews here
 *   protocol.finalizePcztSigning validate responses, apply every signature
 *
 * The result is the `signedPczt` delivery form: the device signs transparent
 * inputs and shielded actions (Orchard or Ironwood), so the PCZT comes back
 * fully signed and the host only extracts it. Code only against the contract
 * (./contract.ts); the protocol (wasm) and transport (WebHID) are injected.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 */

import type { ExternalSigner } from '../../signing/external-signer';
import { versionAtLeast } from '../capabilities';
import { bytesToHex, hexToBytes } from '../hex';
import {
  LedgerError,
  MIN_ZCASH_APP_VERSION_FOR_SIGNING,
  type LedgerFailure,
  type LedgerSigningPhase,
  type LedgerTransparentPath,
  type LedgerZcashDevice,
  type LedgerZcashProtocol,
} from './contract';

/** The device app name while the Zcash app is running. */
export const ZCASH_APP_NAME = 'Zcash';

/** A transparent input's BIP44 tail under the account (one per input, with its pubkey). */
export type { LedgerTransparentPath };

/**
 * Stamp the Ledger account's derivations into an unsigned PCZT: every shielded
 * spend Zip32Derivation(fp, [32', 133', account']), every transparent input
 * exactly one Bip32Derivation(fp, [44', 133', account', scope, index]). The
 * Zcash app refuses to plan a PCZT without them, and zafu's builders do not
 * stamp. Seed fingerprint and account are bound in by the caller (they come
 * from the account import); only the per-transaction transparent paths vary.
 * Production: protocol.stampDerivations (zcli export ledger_stamp_derivations).
 */
export type LedgerDerivationStamper = (
  pczt: Uint8Array,
  opts: { transparentPaths: readonly LedgerTransparentPath[] },
) => Uint8Array;

export interface LedgerSignDeps {
  readonly protocol: LedgerZcashProtocol;
  readonly device: LedgerZcashDevice;
  readonly stampDerivations: LedgerDerivationStamper;
  /** The app's memo-hash support for the version the device reported.
   *  Default: app >= 3.9.4 (older apps can reset on a streamed non-ASCII memo). */
  readonly memoHashSupported?: (appVersion: string) => boolean;
}

/** Apps from this version hash memos on device. */
export const MIN_ZCASH_APP_VERSION_FOR_MEMO_HASH = '3.9.4';

export const defaultMemoHashSupported = (appVersion: string): boolean =>
  !!appVersion && versionAtLeast(appVersion, MIN_ZCASH_APP_VERSION_FOR_MEMO_HASH);

export interface LedgerSignOptions {
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: LedgerSigningPhase) => void;
  /** derivation tails of this PCZT's transparent inputs (shielding); none for a shielded send */
  readonly transparentPaths?: readonly LedgerTransparentPath[];
}

const PROTOCOL_PREFIXES: readonly [string, LedgerFailure][] = [
  ['unsupported_transaction:', 'unsupported_transaction'],
  ['app_too_old:', 'app_too_old'],
  ['protocol_error:', 'protocol_error'], // includes "protocol_error: ledger_signature_mismatch:"
];

/**
 * The wasm protocol reports failures as prefixed strings
 * ("unsupported_transaction: ...", "protocol_error: ledger_signature_mismatch: ...").
 * Map them onto the contract's LedgerError kinds; anything unprefixed is a
 * protocol error too (never a generic throw the UI cannot act on).
 */
export function toLedgerError(e: unknown): LedgerError {
  if (e instanceof LedgerError) {
    return e;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const trimmed = msg.trim();
  for (const [prefix, failure] of PROTOCOL_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return new LedgerError(failure, trimmed.slice(prefix.length).trim() || failure);
    }
  }
  return new LedgerError('protocol_error', msg);
}

const viaProtocol = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    throw toLedgerError(e);
  }
};

const throwIfCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new LedgerError('cancelled', 'cancelled');
  }
};

/**
 * Sign one PCZT on the device. Resolves to the fully signed PCZT bytes.
 * Throws a `LedgerError` whose `failure` tells the UI what the user should do.
 */
export async function signPcztOnLedger(
  deps: LedgerSignDeps,
  unsigned: Uint8Array,
  opts: LedgerSignOptions = {},
): Promise<Uint8Array> {
  const { protocol, device } = deps;
  const { signal, onPhase } = opts;
  throwIfCancelled(signal);

  // The app plans only a PCZT carrying the account's derivations. The PCZT
  // must be the UNREDACTED, IO-finalized build (redaction strips the spend
  // values the device needs).
  const stamped = viaProtocol(() =>
    deps.stampDerivations(unsigned, { transparentPaths: opts.transparentPaths ?? [] }),
  );
  // Limits and unsupported paths fail here, with no device prompt at all.
  viaProtocol(() => protocol.validatePczt(stamped));

  onPhase?.({ phase: 'connecting' });
  let app = await device.currentApp();
  throwIfCancelled(signal);
  if (app.name !== ZCASH_APP_NAME) {
    onPhase?.({ phase: 'open_app' });
    app = await device.openZcashApp({ signal });
    throwIfCancelled(signal);
    if (app.name !== ZCASH_APP_NAME) {
      throw new LedgerError('app_not_open', 'open the Zcash app on your Ledger');
    }
  }
  // Fail closed on an unknown version: an empty string is "too old".
  if (!app.version || !versionAtLeast(app.version, MIN_ZCASH_APP_VERSION_FOR_SIGNING)) {
    throw new LedgerError(
      'app_too_old',
      `Zcash app ${app.version || 'unknown'} is older than ${MIN_ZCASH_APP_VERSION_FOR_SIGNING} - update it in Ledger Live`,
    );
  }

  const memoHashSupported = (deps.memoHashSupported ?? defaultMemoHashSupported)(app.version);
  const plan = viaProtocol(() => protocol.pcztSigningPlan(stamped, { memoHashSupported }));
  if (plan.length === 0) {
    throw new LedgerError('protocol_error', 'empty signing plan');
  }
  throwIfCancelled(signal);

  const responses = await device.exchange(plan, { signal, onPhase });
  throwIfCancelled(signal);
  if (responses.length !== plan.length) {
    throw new LedgerError(
      'protocol_error',
      `device answered ${responses.length} of ${plan.length} commands`,
    );
  }
  // responses are payloads with status words already stripped by the transport
  return viaProtocol(() => protocol.finalizePcztSigning(stamped, responses));
}

/**
 * The Ledger cold signer in zafu's service shape. Pool-agnostic: it returns a
 * signed PCZT, which the host extracts (never the orchard inject role).
 */
export function ledgerZcashSigner(
  deps: LedgerSignDeps,
  opts: LedgerSignOptions = {},
): ExternalSigner {
  return async ({ pcztHex }) => {
    const signed = await signPcztOnLedger(deps, hexToBytes(pcztHex), opts);
    return { kind: 'signedPczt', pcztHex: bytesToHex(signed) };
  };
}
