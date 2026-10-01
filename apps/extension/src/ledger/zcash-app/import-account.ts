/**
 * Export a SHIELDED Zcash account from the Ledger Zcash app, for import as a
 * watch-only zafu wallet (coldSignerType 'ledger', custody 'ledger-zcash').
 *
 * Pure orchestration over the contract: the device (transport) and protocol
 * are injected, so this runs and tests without WebHID or the wasm blob.
 *
 *   1. make sure the Zcash app is open (ask the device to open it if not)
 *   2. refuse an app older than MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS BEFORE
 *      the device is asked to share a viewing key
 *   3. send the UFVK export: `first` (the user confirms on the device), then
 *      `continuation` until the protocol says no UFVK bytes are still owed
 *   4. parse + validate the responses into { ufvk, seedFingerprint, index }
 *
 * Mainnet only: the app's UFVK request is always built for coin type 133, so
 * a testnet import is refused up front.
 *
 * The UFVK is returned to the caller for persistence only. Nothing here logs it.
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 * (lib/src/features/ledger/services/ledger_account_service.dart,
 *  ledger_onboarding_policy.dart, ledger_capability.dart, ledger_device_label.dart)
 */

import { bytesToHex } from '../hex';
import type { LedgerImport } from '../../state/keyring/types';
import type { LedgerZcashProtocol } from './contract';
import {
  LedgerError,
  MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS,
  type LedgerSigningPhase,
  type LedgerZcashDevice,
} from './contract';

/** Product limit for user-chosen onboarding account indexes (vizor policy). */
export const MAX_LEDGER_ONBOARDING_ACCOUNT_INDEX = 100;

export const isLedgerAccountIndexValid = (index: number | null | undefined): index is number =>
  typeof index === 'number' &&
  Number.isInteger(index) &&
  index >= 0 &&
  index <= MAX_LEDGER_ONBOARDING_ACCOUNT_INDEX;

/** Parse the account-index input; null when not a valid 0..100 integer. */
export const parseLedgerAccountIndex = (text: string): number | null => {
  const t = text.trim();
  if (!/^\d+$/.test(t)) {
    return null;
  }
  const n = Number.parseInt(t, 10);
  return isLedgerAccountIndexValid(n) ? n : null;
};

const parseVersion = (v: string): [number, number, number] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Strict x.y.z comparison; an unparsable version fails closed (too old). */
export const appVersionAtLeast = (version: string, minimum: string): boolean => {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i]! > b[i]!;
    }
  }
  return true;
};

export const appAllowsNewAccounts = (version: string): boolean =>
  appVersionAtLeast(version, MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS);

/**
 * Human label for the device, from WebHID `productName` ("Nano S Plus",
 * "Nano X", ...). Presentation only: never use it to identify an account.
 */
export function ledgerDeviceLabel(productName: string | undefined | null): string {
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = compact(productName ?? '').replace(/^ledger/, '');
  const byKey: Record<string, string> = {
    nanos: 'Ledger Nano S',
    nanosplus: 'Ledger Nano S Plus',
    nanosp: 'Ledger Nano S Plus',
    nanox: 'Ledger Nano X',
    flex: 'Ledger Flex',
    stax: 'Ledger Stax',
    nanogen5: 'Ledger Nano Gen5',
    apex: 'Ledger Nano Gen5',
  };
  return byKey[key] ?? 'Ledger';
}

/** What the connect screen hands to the keyring. */
export interface LedgerZcashAccount {
  readonly ufvk: string;
  /** 32-byte account fingerprint, hex (NOT the ZIP-32 seed fingerprint, which
   *  the device does not expose: SHA-256 over a domain tag, the account index
   *  and the UFVK). Dedupe key with accountIndex; the send flow stamps it into
   *  PCZT derivations. Not key material. */
  readonly seedFingerprintHex: string;
  readonly accountIndex: number;
  readonly appVersion: string;
  readonly deviceLabel: string;
}

export interface ExportLedgerAccountDeps {
  readonly device: LedgerZcashDevice;
  readonly protocol: Pick<LedgerZcashProtocol, 'ufvkPlan' | 'ufvkRemainingBytes' | 'parseUfvk'>;
  readonly network: 'main' | 'test';
  /** WebHID productName, for the label only */
  readonly productName?: string;
}

/** Upper bound on continuation APDUs for one UFVK (a UFVK is a few hundred bytes). */
export const MAX_UFVK_CONTINUATIONS = 64;

/** Progress of the export, for the connect screen. */
export type LedgerExportStep =
  | { step: 'checking_app' }
  | { step: 'opening_app' }
  | { step: 'confirm_on_device' }
  | { step: 'device'; phase: LedgerSigningPhase };

export interface ExportLedgerAccountOptions {
  readonly accountIndex: number;
  readonly signal?: AbortSignal;
  readonly onStep?: (s: LedgerExportStep) => void;
}

const isZcashApp = (name: string) => name.trim().toLowerCase() === 'zcash';

export async function exportLedgerZcashAccount(
  deps: ExportLedgerAccountDeps,
  opts: ExportLedgerAccountOptions,
): Promise<LedgerZcashAccount> {
  const { device, protocol, network } = deps;
  const { accountIndex, signal, onStep } = opts;

  if (!isLedgerAccountIndexValid(accountIndex)) {
    // a host-side input error, not a device failure: the UI validates first
    throw new RangeError(
      `account index must be between 0 and ${MAX_LEDGER_ONBOARDING_ACCOUNT_INDEX}`,
    );
  }
  if (network !== 'main') {
    throw new LedgerError(
      'unsupported_transaction',
      'ledger import is mainnet only for now (the zcash app exports mainnet keys)',
    );
  }
  const checkAbort = () => {
    if (signal?.aborted) {
      throw new LedgerError('cancelled');
    }
  };

  onStep?.({ step: 'checking_app' });
  let app = await device.currentApp();
  checkAbort();
  if (!isZcashApp(app.name)) {
    onStep?.({ step: 'opening_app' });
    app = await device.openZcashApp({ signal });
    checkAbort();
    if (!isZcashApp(app.name)) {
      throw new LedgerError('app_not_open', `the ${app.name || 'current'} app is open, not zcash`);
    }
  }

  // Refuse before asking the device to share a viewing key.
  if (!appAllowsNewAccounts(app.version)) {
    throw new LedgerError(
      'app_too_old',
      `zcash app ${app.version} is older than ${MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS}`,
    );
  }

  const plan = protocol.ufvkPlan(accountIndex);
  const [first, continuation] = plan;
  if (!first || !continuation) {
    throw new LedgerError('protocol_error', 'ufvk plan must be [first, continuation]');
  }
  const onPhase = (phase: LedgerSigningPhase) => onStep?.({ step: 'device', phase });
  onStep?.({ step: 'confirm_on_device' });
  const responses = [...(await device.exchange([first], { signal, onPhase }))];
  checkAbort();
  // The device streams the UFVK in chunks; keep asking while bytes are owed.
  // Bounded, and each round must make progress, so a confused device or
  // protocol can never spin forever.
  let remaining = protocol.ufvkRemainingBytes(responses);
  for (let round = 0; remaining > 0; round++) {
    if (round >= MAX_UFVK_CONTINUATIONS) {
      throw new LedgerError('protocol_error', 'ledger kept sending the viewing key');
    }
    responses.push(...(await device.exchange([continuation], { signal, onPhase })));
    checkAbort();
    const next = protocol.ufvkRemainingBytes(responses);
    if (next >= remaining) {
      throw new LedgerError('protocol_error', 'ledger viewing key export made no progress');
    }
    remaining = next;
  }

  const exported = protocol.parseUfvk(responses, network, accountIndex);
  if (exported.accountIndex !== accountIndex) {
    throw new LedgerError('protocol_error', 'device exported a different account than requested');
  }
  const expectedHrp = network === 'main' ? 'uview1' : 'uviewtest1';
  if (!exported.ufvk.startsWith(expectedHrp)) {
    throw new LedgerError('protocol_error', 'device exported a viewing key for another network');
  }
  if (exported.seedFingerprint.length !== 32) {
    throw new LedgerError('protocol_error', 'device exported a malformed seed fingerprint');
  }

  return {
    ufvk: exported.ufvk,
    seedFingerprintHex: bytesToHex(exported.seedFingerprint),
    accountIndex,
    appVersion: app.version,
    deviceLabel: ledgerDeviceLabel(deps.productName),
  };
}

/** Minimal key/value surface for the per-vault birthday (chrome.storage.local shape). */
export interface BirthdayStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Persist the wallet birthday as `zcashBirthday_<vaultId>` (the key auto-sync
 * reads), clamped to `minHeight`. Only ever LOWERS an existing value: on a
 * dedupe re-import the vault may already be synced, and raising its birthday
 * would make the scanner skip notes below it.
 */
export async function writeBirthdayIfEarlier(
  store: BirthdayStore,
  vaultId: string,
  height: number,
  minHeight: number,
): Promise<void> {
  if (!Number.isFinite(height)) {
    return;
  }
  const key = `zcashBirthday_${vaultId}`;
  const next = Math.max(minHeight, Math.floor(height));
  const stored = (await store.get(key))[key];
  if (typeof stored === 'number' && Number.isFinite(stored) && stored <= next) {
    return;
  }
  await store.set({ [key]: next });
}

export interface SaveLedgerAccountDeps {
  /** keyring.addLedgerUnencrypted: returns the new OR existing (deduped) vault id */
  readonly addLedger: (data: LedgerImport, name: string) => Promise<string>;
  /** default unified address for the UFVK (address_from_ufvk) */
  readonly deriveAddress: (ufvk: string) => Promise<string>;
  readonly birthdayStore: BirthdayStore;
  readonly minBirthdayHeight: number;
}

export interface SaveLedgerAccountInput {
  readonly account: LedgerZcashAccount;
  readonly label: string;
  readonly mainnet: boolean;
  /** null = no birthday chosen (sync starts near the tip, like other imports) */
  readonly birthdayHeight: number | null;
}

/** Create (or re-select) the watch-only wallet for an exported Ledger account. */
export async function saveLedgerZcashAccount(
  deps: SaveLedgerAccountDeps,
  input: SaveLedgerAccountInput,
): Promise<string> {
  const address = await deps.deriveAddress(input.account.ufvk);
  const data = toLedgerZcashImport(input.account, { address, mainnet: input.mainnet });
  const label =
    input.label.trim() ||
    `${input.account.deviceLabel.toLowerCase()} #${input.account.accountIndex}`;
  const vaultId = await deps.addLedger(data, label);
  if (input.birthdayHeight != null) {
    await writeBirthdayIfEarlier(
      deps.birthdayStore,
      vaultId,
      input.birthdayHeight,
      deps.minBirthdayHeight,
    );
  }
  return vaultId;
}

/** Stable per-seed device id; the keyring dedupes on it + accountIndex. */
export const ledgerZcashDeviceId = (seedFingerprintHex: string) =>
  `ledger-zcash-${seedFingerprintHex}`;

/**
 * Map an exported account onto the keyring's LedgerImport. `address` is the
 * default unified address derived from the UFVK (display + receive fallback;
 * the wallet re-derives from the UFVK at runtime anyway).
 */
export function toLedgerZcashImport(
  account: LedgerZcashAccount,
  opts: { address: string; mainnet: boolean },
): LedgerImport {
  return {
    address: opts.address,
    ufvk: account.ufvk,
    accountIndex: account.accountIndex,
    deviceId: ledgerZcashDeviceId(account.seedFingerprintHex),
    mainnet: opts.mainnet,
    custody: 'ledger-zcash',
    seedFingerprint: account.seedFingerprintHex,
    appVersion: account.appVersion,
    deviceLabel: account.deviceLabel,
  };
}
