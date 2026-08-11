/**
 * Ledger as an `ExternalSigner` service (see external-signer.ts).
 *
 * Base service = sign the PCZT over WebHID on a connected device. Filters gate
 * it: `requireFlag` (hardware-wallet feature) and `requireShieldedApp` (app-zcash
 * >= 3.8.0, which is what exposes orchard PCZT signing + UFVK export). Because
 * the device is TRUSTED and holds the seed, it receives the un-redacted PCZT
 * (unlike zigner's redacted QR path) - the redaction is a transport-trust
 * measure the Ledger transport doesn't need.
 */

import { HARDWARE_WALLET_ENABLED } from '../config/feature-flags';
import { signPcztWithLedger } from '../ledger';
import { versionAtLeast, MIN_SHIELDED_APP_VERSION } from '../ledger/capabilities';
import { compose, type ExternalSigner, type SignerFilter } from './external-signer';

/** A connected Ledger session (from `connectLedger()` in the connect/pair step). */
export interface LedgerSession {
  sessionId: string;
  appVersion: string;
}

/** Base service: pure sign against an already-connected session. The device
 *  returns raw orchard spend-auth sigs, so this is the `spendAuthSigs` (inject)
 *  delivery form - see external-signer.ts / cold-send.ts. */
function ledgerSignWith(session: LedgerSession): ExternalSigner {
  return async ({ pcztHex, spendIndices, mainnet }) => {
    const signed = await signPcztWithLedger(session.sessionId, pcztHex, { spendIndices, mainnet });
    return {
      kind: 'spendAuthSigs',
      spendAuthSigs: signed.orchardSigs,
      spendIndices: signed.spendIndices,
    };
  };
}

/** Filter: refuse unless the hardware-wallet feature is enabled. */
const requireFlag: SignerFilter = next => req => {
  if (!HARDWARE_WALLET_ENABLED) {
    return Promise.reject(new Error('hardware wallet support is not enabled'));
  }
  return next(req);
};

// versionAtLeast + MIN_SHIELDED_APP_VERSION now live in ../ledger/capabilities
// (single source for the "current app in, ready for future" capability model).

/** Filter: refuse shielded signing unless the device app is new enough. An
 *  empty/unknown version is treated as too old - the gate must fail CLOSED. */
function requireShieldedApp(appVersion: string): SignerFilter {
  return next => req => {
    if (!appVersion) {
      return Promise.reject(
        new Error('ledger zcash app version unknown - refusing to sign; reconnect the device'),
      );
    }
    if (!versionAtLeast(appVersion, MIN_SHIELDED_APP_VERSION)) {
      return Promise.reject(
        new Error(
          `ledger zcash app ${appVersion} < ${MIN_SHIELDED_APP_VERSION}: ` +
            'shielded signing unavailable - update the Zcash app in Ledger Live',
        ),
      );
    }
    return next(req);
  };
}

/**
 * The Ledger cold signer for a connected device: base sign wrapped in the
 * feature-flag + app-version filters. Compose more filters (tracing, retry) here
 * without touching the send flow.
 */
export function ledgerSignerFor(session: LedgerSession): ExternalSigner {
  // The version gate is ALWAYS applied. Previously a missing/empty appVersion
  // swapped in `identityFilter`, which silently removed the gate - and since
  // AppConfig has no `version` field, appVersion was empty in practice, so the
  // "app >= 3.8.0" check never ran. Fail closed instead.
  return compose(requireFlag, requireShieldedApp(session.appVersion))(ledgerSignWith(session));
}
