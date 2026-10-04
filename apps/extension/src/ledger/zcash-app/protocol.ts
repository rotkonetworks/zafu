/**
 * PROTOCOL half of the Ledger Zcash app contract (see ./contract.ts): a thin,
 * typed wrapper over the wasm exports ported from vizor into zcli's zcash-wasm
 * (vendored as @repo/zcash-wasm).
 *
 * This file knows nothing about the wire format. It only:
 *   - checks the export exists (an older wasm blob lacks them) and fails with
 *     LedgerError('protocol_error') instead of a TypeError deep in the UI,
 *   - normalises what crosses the wasm boundary into the contract's types,
 *   - maps a wasm throw to LedgerError('protocol_error') unless the wasm
 *     already threw a LedgerError-shaped value (e.g. unsupported_transaction).
 *
 * wasm exports (zcli feat/ledger-zcash-app, crates/zcash-wasm/src/ledger/mod.rs):
 *   ledger_ufvk_plan(account: u32) -> [first, continuation] as {cla, ins, p1, p2, data}
 *     NOT a fixed plan: send `first`, then repeat `continuation` while
 *   ledger_ufvk_remaining_bytes(responsesSoFar: Uint8Array[]) -> u32 is > 0
 *   ledger_parse_ufvk(responses: Uint8Array[], network: 'main'|'test', account: u32)
 *     -> {ufvk, seedFingerprint: Uint8Array(32), accountIndex}
 *     The request is always mainnet (coin type 133). seedFingerprint is NOT
 *     the ZIP-32 seed fingerprint (the device does not expose it): it is
 *     SHA-256("zafu-ledger-account-fingerprint-v1\0" || account BE || ufvk),
 *     the account's dedupe key and the value the send flow stamps into PCZT
 *     derivations.
 *   ledger_validate_pczt(pczt: Uint8Array) -> void (throws)
 *   ledger_pczt_signing_plan(pczt: Uint8Array, memo_hash_supported: bool) -> plan
 *   ledger_finalize_pczt_signing(pczt: Uint8Array, responses: Uint8Array[]) -> Uint8Array
 * Errors are JsErrors whose message starts with a LedgerFailure prefix
 * (`unsupported_transaction:` / `app_too_old:` / `protocol_error:`).
 */

import {
  LedgerError,
  type ApduCommand,
  type LedgerAccountExport,
  type LedgerFailure,
  type LedgerZcashProtocol,
} from './contract';

/** The raw wasm surface this wrapper expects. Every export is optional on purpose. */
export interface LedgerWasmExports {
  ledger_ufvk_plan?: (accountIndex: number) => unknown;
  ledger_ufvk_remaining_bytes?: (responses: Uint8Array[]) => unknown;
  ledger_parse_ufvk?: (responses: Uint8Array[], network: string, accountIndex: number) => unknown;
  ledger_validate_pczt?: (pczt: Uint8Array) => unknown;
  ledger_pczt_signing_plan?: (pczt: Uint8Array, memoHashSupported: boolean) => unknown;
  ledger_finalize_pczt_signing?: (pczt: Uint8Array, responses: Uint8Array[]) => unknown;
  ledger_stamp_derivations?: (
    pczt: Uint8Array,
    seedFingerprint: Uint8Array,
    accountIndex: number,
    transparentPaths: unknown,
  ) => unknown;
}

const MISSING = 'wasm build lacks ledger exports';

const FAILURES: readonly LedgerFailure[] = [
  'not_connected',
  'locked',
  'app_not_open',
  'app_too_old',
  'rejected',
  'busy',
  'unsupported_transaction',
  'change_to_other_account',
  'cancelled',
  'protocol_error',
];

function need<K extends keyof LedgerWasmExports>(
  wasm: LedgerWasmExports,
  name: K,
): NonNullable<LedgerWasmExports[K]> {
  const fn = wasm[name];
  if (typeof fn !== 'function') {
    throw new LedgerError('protocol_error', MISSING);
  }
  return fn as NonNullable<LedgerWasmExports[K]>;
}

/**
 * Run a wasm call, mapping a throw to a LedgerError. The wasm may prefix its
 * message with a failure kind (`unsupported_transaction: ...`) to keep it; any
 * other throw is a protocol_error. The original message never includes key
 * material (the wasm side guarantees that), so it is safe to surface.
 */
function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof LedgerError) {
      throw cause;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    const kind = FAILURES.find(f => message.startsWith(`${f}:`));
    throw new LedgerError(kind ?? 'protocol_error', message);
  }
}

function fromJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new LedgerError('protocol_error', 'wasm returned malformed json');
    }
  }
  return value;
}

function toBytes(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value) && value.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value === 'string' && /^([0-9a-f]{2})*$/i.test(value)) {
    const out = new Uint8Array(value.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  throw new LedgerError('protocol_error', `wasm returned a malformed ${what}`);
}

function byte(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255) {
    return value;
  }
  throw new LedgerError('protocol_error', `wasm returned a malformed apdu ${what}`);
}

/** Normalise a wasm APDU plan into contract ApduCommands. Exported for tests. */
export function toApduPlan(raw: unknown): ApduCommand[] {
  const value = fromJson(raw);
  if (!Array.isArray(value) || value.length === 0) {
    throw new LedgerError('protocol_error', 'wasm returned an empty apdu plan');
  }
  return value.map((c: unknown) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return {
      cla: byte(o['cla'], 'cla'),
      ins: byte(o['ins'], 'ins'),
      p1: byte(o['p1'], 'p1'),
      p2: byte(o['p2'], 'p2'),
      data: toBytes(o['data'] ?? [], 'apdu payload'),
    };
  });
}

/** Normalise the wasm UFVK export. Exported for tests. */
export function toAccountExport(raw: unknown): LedgerAccountExport {
  const o = (fromJson(raw) ?? {}) as Record<string, unknown>;
  const ufvk = o['ufvk'];
  const accountIndex = o['accountIndex'] ?? o['account_index'];
  if (typeof ufvk !== 'string' || !ufvk.startsWith('uview')) {
    throw new LedgerError('protocol_error', 'device returned no unified viewing key');
  }
  if (typeof accountIndex !== 'number' || !Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new LedgerError('protocol_error', 'device returned no account index');
  }
  const seedFingerprint = toBytes(
    o['seedFingerprint'] ?? o['seed_fingerprint'],
    'seed fingerprint',
  );
  if (seedFingerprint.length !== 32) {
    throw new LedgerError('protocol_error', 'device returned a malformed seed fingerprint');
  }
  return { ufvk, seedFingerprint, accountIndex };
}

/**
 * @deprecated the UFVK loop is part of the contract now; kept as an alias so
 * existing imports keep compiling.
 */
export type LedgerZcashAccountProtocol = LedgerZcashProtocol;

/** Build the protocol over an already-initialised wasm module. Pure; used by tests. */
export function createLedgerZcashProtocol(wasm: LedgerWasmExports): LedgerZcashProtocol {
  return {
    ufvkPlan: accountIndex => {
      const fn = need(wasm, 'ledger_ufvk_plan');
      const plan = toApduPlan(call(() => fn(accountIndex)));
      if (plan.length !== 2) {
        throw new LedgerError('protocol_error', 'ufvk plan must be [first, continuation]');
      }
      return plan;
    },
    ufvkRemainingBytes: responses => {
      const fn = need(wasm, 'ledger_ufvk_remaining_bytes');
      const n = call(() => fn(responses));
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new LedgerError('protocol_error', 'wasm returned a malformed remaining byte count');
      }
      return n;
    },
    parseUfvk: (responses, network, accountIndex) => {
      const fn = need(wasm, 'ledger_parse_ufvk');
      return toAccountExport(call(() => fn(responses, network, accountIndex)));
    },
    validatePczt: pczt => {
      const fn = need(wasm, 'ledger_validate_pczt');
      call(() => fn(pczt));
    },
    pcztSigningPlan: (pczt, opts) => {
      const fn = need(wasm, 'ledger_pczt_signing_plan');
      return toApduPlan(call(() => fn(pczt, opts.memoHashSupported)));
    },
    stampDerivations: (pczt, opts) => {
      const fn = need(wasm, 'ledger_stamp_derivations');
      if (opts.seedFingerprint.length !== 32) {
        throw new LedgerError('protocol_error', 'seed fingerprint must be 32 bytes');
      }
      // zcli takes snake_case plain objects; null when there is no transparent input
      const paths = opts.transparentPaths.length
        ? opts.transparentPaths.map(p => ({
            input_index: p.inputIndex,
            scope: p.scope,
            address_index: p.addressIndex,
            pubkey: p.pubkey,
          }))
        : null;
      return toBytes(
        call(() => fn(pczt, opts.seedFingerprint, opts.accountIndex, paths)),
        'stamped pczt',
      );
    },
    finalizePcztSigning: (pczt, responses) => {
      const fn = need(wasm, 'ledger_finalize_pczt_signing');
      return toBytes(
        call(() => fn(pczt, responses)),
        'signed pczt',
      );
    },
  };
}

let cachedWasm: Promise<LedgerWasmExports> | null = null;
let cached: Promise<LedgerZcashAccountProtocol> | null = null;

const loadWasm = (): Promise<LedgerWasmExports> => {
  cachedWasm ??= (async () => {
    const mod = (await import('@repo/zcash-wasm')) as unknown as LedgerWasmExports & {
      default?: (opts?: { module_or_path?: string }) => Promise<unknown>;
    };
    if (typeof mod.default === 'function') {
      await mod.default();
    }
    return mod as LedgerWasmExports;
  })().catch((cause: unknown) => {
    cachedWasm = null;
    throw cause;
  });
  return cachedWasm;
};

/** Load + init @repo/zcash-wasm once and wrap it. Page context only (WebHID lives there). */
export function loadLedgerZcashProtocol(): Promise<LedgerZcashAccountProtocol> {
  cached ??= loadWasm()
    .then(createLedgerZcashProtocol)
    .catch((cause: unknown) => {
      cached = null;
      throw cause;
    });
  return cached;
}
