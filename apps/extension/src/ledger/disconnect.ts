import { LedgerError, type LedgerFailure } from './zcash-app/contract';

/**
 * Whether a ledger error means the device went away (unplugged, locked, the
 * zcash app closed, the picker dismissed) rather than a refusal or a bug.
 * DMK errors arrive JSON-stringified with their `_tag`; hw-transport errors
 * carry the name. Either way nothing was signed, so the same build can be
 * signed again once the device is back.
 */
const GONE =
  /disconnect|DeviceSessionNotFound|DeviceNotRecognized|DeviceLocked|no device selected|device must be opened|no active ledger session|ledger session mismatch|\b(0x)?6e0[01]\b|\b(0x)?6d00\b/i;

/** the zcash app transport's own kinds for the same situation */
const GONE_FAILURES = new Set<LedgerFailure>(['not_connected', 'locked', 'app_not_open']);

export const isLedgerGone = (err: unknown): boolean =>
  (err instanceof LedgerError && GONE_FAILURES.has(err.failure)) ||
  GONE.test(
    err instanceof Error
      ? `${err.name} ${err.message}`
      : typeof err === 'string'
        ? err
        : (JSON.stringify(err) ?? ''),
  );
