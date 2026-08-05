// Translate zafu's PCZT into device-signer-kit-zcash's STRUCTURED
// PcztTransaction object.
//
// DECODING HAPPENS IN RUST. zafu has no JS PCZT parser and should not grow one:
// the pczt-crate serialization (postcard/serde of nested Option/Vec) is already
// decoded in the wasm crate. `frost_inspect_pczt_outputs` (zcli-ironwood
// crates/zcash-wasm/src/lib.rs) already opens a PCZT and walks its Orchard
// actions - that is the code to clone into a new `describe_pczt_for_ledger`
// export (spec at the bottom of this file). This module then does a THIN, pure,
// fully-typed mapping from that Rust-emitted JSON into the device shape.
//
// SCOPE: Orchard V5 only. @ledgerhq/device-signer-kit-zcash 0.5.0 DOES model
// ironwood (PcztIronwoodBundle / PcztIronwoodAction, V6), but zafu has no
// Rust-side describe for it, so the V6 path throws via the stub at the bottom.
// Post-NU6.3 that means the shielded Ledger send path is effectively dead on
// mainnet - see the note on pcztHexToLedgerIronwoodTransaction.
//
// The device-side shapes below are typechecked against the INSTALLED
// @ledgerhq/device-signer-kit-zcash types (0.5.0), not against a hand-written
// shim. What remains unverified is the *semantics* on a real device.

import type {
  PcztGlobal,
  PcztOrchardAction,
  PcztOrchardBundle,
  PcztTransaction,
} from '@ledgerhq/device-signer-kit-zcash';
import { hexToBytes } from './hex';

export interface PcztTranslateOptions {
  readonly mainnet: boolean;
}

// ── Rust decode boundary (JSON emitted by describe_pczt_for_ledger) ─────────
// JSON cannot carry Uint8Array or bigint, so byte fields are lowercase-hex
// strings and value fields are decimal strings (signed for valueBalance). This
// is the contract the wasm export must honor; keep it in sync with the Rust.

export interface LedgerPcztGlobalJson {
  readonly txVersion: number;
  readonly versionGroupId: number;
  readonly consensusBranchId: number;
  readonly expiryHeight: number;
  readonly coinType: number;
  /** `null` encodes the PCZT's absent-Option tag; the device requires the field. */
  readonly fallbackLockTime: number | null;
  /** required by the device wire format - must come from the PCZT, not a default. */
  readonly txModifiable: number;
}

export interface LedgerPcztOrchardActionJson {
  readonly cvNet: string;
  readonly nullifier: string;
  readonly rk: string;
  readonly spendRecipient: string; // 43 bytes hex
  readonly spendValue: string; // decimal
  readonly spendRho: string;
  readonly spendRseed: string;
  readonly alpha: string; // 32 bytes hex
  /** ZIP-32 path STRING, e.g. "32'/133'/0'" - the device model takes a string,
   *  not an array of path components. */
  readonly signingPath: string;
  readonly seedFingerprint: string;
  readonly cmx: string;
  readonly ephemeralKey: string;
  readonly encCiphertext: string;
  readonly outCiphertext: string;
  readonly recipient: string; // 43 bytes hex
  readonly value: string; // decimal
  readonly rseed: string;
  readonly rcv: string; // 32 bytes hex
}

export interface LedgerPcztOrchardBundleJson {
  readonly actions: readonly LedgerPcztOrchardActionJson[];
  readonly flags: number;
  readonly valueBalance: string; // signed decimal
  readonly anchor: string;
}

export interface LedgerPcztDescribe {
  readonly global: LedgerPcztGlobalJson;
  readonly orchardBundle: LedgerPcztOrchardBundleJson | null;
  // transparentInputs / transparentOutputs: omitted - the Ledger send path is a
  // shielded-only Orchard spend (mirrors the zigner branch). Add here (and in
  // the mapper + Rust export) if transparent legs are ever supported.
}

// ── pure mapping: Rust JSON -> device PcztTransaction ───────────────────────

function mapGlobal(g: LedgerPcztGlobalJson): PcztGlobal {
  return {
    txVersion: g.txVersion,
    versionGroupId: g.versionGroupId,
    consensusBranchId: g.consensusBranchId,
    expiryHeight: g.expiryHeight,
    coinType: g.coinType,
    // Both are REQUIRED by the device wire format. Dropping them when null (as
    // an earlier version did) produced a PcztGlobal the device would reject or,
    // worse, parse with shifted field offsets. `fallbackLockTime: null` is the
    // explicit "absent Option" encoding; txModifiable must be a real value.
    fallbackLockTime: g.fallbackLockTime,
    txModifiable: g.txModifiable,
  };
}

function mapOrchardAction(a: LedgerPcztOrchardActionJson): PcztOrchardAction {
  return {
    cvNet: hexToBytes(a.cvNet),
    nullifier: hexToBytes(a.nullifier),
    rk: hexToBytes(a.rk),
    spendRecipient: hexToBytes(a.spendRecipient),
    spendValue: BigInt(a.spendValue),
    spendRho: hexToBytes(a.spendRho),
    spendRseed: hexToBytes(a.spendRseed),
    alpha: hexToBytes(a.alpha),
    signingPath: a.signingPath,
    seedFingerprint: hexToBytes(a.seedFingerprint),
    cmx: hexToBytes(a.cmx),
    ephemeralKey: hexToBytes(a.ephemeralKey),
    encCiphertext: hexToBytes(a.encCiphertext),
    outCiphertext: hexToBytes(a.outCiphertext),
    recipient: hexToBytes(a.recipient),
    value: BigInt(a.value),
    rseed: hexToBytes(a.rseed),
    rcv: hexToBytes(a.rcv),
  };
}

function mapOrchardBundle(b: LedgerPcztOrchardBundleJson): PcztOrchardBundle {
  return {
    actions: b.actions.map(mapOrchardAction),
    flags: b.flags,
    valueBalance: BigInt(b.valueBalance),
    anchor: hexToBytes(b.anchor),
  };
}

/**
 * Pure, synchronous mapping from the Rust-decoded describe JSON to the device's
 * PcztTransaction. No wasm, no I/O - trivially unit-testable with a fixture.
 */
export function ledgerDescribeToPcztTransaction(describe: LedgerPcztDescribe): PcztTransaction {
  return {
    global: mapGlobal(describe.global),
    transparentInputs: [],
    transparentOutputs: [],
    orchardBundle: describe.orchardBundle ? mapOrchardBundle(describe.orchardBundle) : null,
  };
}

// ── async entry: decode in Rust, then map ───────────────────────────────────

interface ZcashWasmDescribe {
  default?: (opts?: { module_or_path?: string }) => Promise<unknown>;
  // TODO(rust): add this export to zcli-ironwood crates/zcash-wasm/src/lib.rs
  // (see spec below) and re-vendor packages/zcash-wasm. Typed optional so a
  // missing export fails loudly at runtime rather than at wasm-load.
  describe_pczt_for_ledger?: (pcztHex: string, mainnet: boolean) => string;
}

/**
 * Translate a zafu Orchard-V5 PCZT (hex) into the device's PcztTransaction by
 * calling the Rust decoder, then mapping its JSON output.
 *
 * NOTE ON CONTEXT: this dynamically imports @repo/zcash-wasm and runs the
 * decoder inline. If zafu prefers to keep all wasm in the worker, the consumer
 * can instead obtain the describe JSON via a worker RPC (clone of the
 * frost_inspect_pczt_outputs verb) and call ledgerDescribeToPcztTransaction
 * directly - the pure mapper above is the reusable core either way.
 */
export async function pcztHexToLedgerPcztTransaction(
  pcztHex: string,
  options: PcztTranslateOptions,
): Promise<PcztTransaction> {
  const zwasm = (await import('@repo/zcash-wasm')) as unknown as ZcashWasmDescribe;
  if (typeof zwasm.default === 'function') {
    await zwasm.default();
  }
  if (typeof zwasm.describe_pczt_for_ledger !== 'function') {
    throw new Error(
      'describe_pczt_for_ledger missing from @repo/zcash-wasm - add it to the ' +
        'zcli-ironwood zcash-wasm crate and re-vendor (see spec in pczt-translate.ts)',
    );
  }
  const json = zwasm.describe_pczt_for_ledger(pcztHex, options.mainnet);
  return ledgerDescribeToPcztTransaction(parseDescribe(json));
}

/**
 * Validate the Rust-emitted describe JSON before it reaches the device mapper.
 *
 * `JSON.parse(...) as LedgerPcztDescribe` is an unchecked assertion: a missing
 * numeric field becomes `undefined` and rides straight into the APDU stream as
 * a field the device parses as garbage, and a missing hex string turns into a
 * `hexToBytes(undefined)` TypeError at best. On a money path the boundary must
 * be checked, so this refuses anything that does not carry every field the
 * device requires.
 */
function parseDescribe(json: string): LedgerPcztDescribe {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('describe_pczt_for_ledger returned a non-object');
  }
  const { global, orchardBundle } = raw as Record<string, unknown>;
  if (typeof global !== 'object' || global === null) {
    throw new Error('describe_pczt_for_ledger: missing global');
  }
  const g = global as Record<string, unknown>;
  for (const field of [
    'txVersion',
    'versionGroupId',
    'consensusBranchId',
    'expiryHeight',
    'coinType',
    'txModifiable',
  ]) {
    if (typeof g[field] !== 'number' || !Number.isFinite(g[field])) {
      throw new Error(`describe_pczt_for_ledger: global.${field} is not a number`);
    }
  }
  if (g['fallbackLockTime'] !== null && typeof g['fallbackLockTime'] !== 'number') {
    throw new Error('describe_pczt_for_ledger: global.fallbackLockTime must be a number or null');
  }
  // V5/orchard only. A V6 (ironwood) PCZT mapped through the orchard bundle
  // would bind a signature over the wrong transaction shape - fail closed.
  if (g['txVersion'] !== 5) {
    throw new Error(
      `ledger orchard signing expects a V5 transaction, got txVersion ${String(g['txVersion'])}`,
    );
  }
  const expectedCoinType = g['coinType'];
  if (expectedCoinType !== 133 && expectedCoinType !== 1) {
    throw new Error(
      `describe_pczt_for_ledger: unexpected coinType ${String(expectedCoinType)} (want 133 or 1)`,
    );
  }
  if (
    orchardBundle !== null &&
    (typeof orchardBundle !== 'object' || orchardBundle === undefined)
  ) {
    throw new Error('describe_pczt_for_ledger: orchardBundle must be an object or null');
  }
  return raw as LedgerPcztDescribe;
}

/**
 * Ironwood (NU6.3 / V6) translation stub - NOT IMPLEMENTED.
 *
 * The blocker is on zafu's side, not Ledger's: device-signer-kit-zcash 0.5.0
 * already models `PcztIronwoodBundle` and returns per-action ironwood
 * `spendAuthSig`s, but zafu has no Rust describe that emits an ironwood bundle
 * (`describe_pczt_for_ledger` itself does not exist yet either).
 *
 * Consequence, stated plainly: NU6.3 activated at mainnet height 3,428,143 and
 * orchard->orchard sends are consensus-disabled, so on mainnet the only
 * shielded send a Ledger could sign today is one the network will reject. This
 * path fails loudly rather than mis-signing a V6 transaction as V5.
 */
export function pcztHexToLedgerIronwoodTransaction(
  _pcztHex: string,
  _options: PcztTranslateOptions,
): never {
  throw new Error(
    'ironwood (V6) ledger signing is not implemented in zafu - no rust describe for ironwood bundles',
  );
}

// ── RUST SPEC: describe_pczt_for_ledger (add to zcli-ironwood) ───────────────
//
// Clone frost_inspect_pczt_outputs (crates/zcash-wasm/src/lib.rs) - it already
// does `Pczt::parse(&bytes)` and iterates the Orchard bundle. Instead of
// returning only outputs, serialize the full decode the device needs:
//
//   #[wasm_bindgen]
//   pub fn describe_pczt_for_ledger(pczt_hex: &str, mainnet: bool) -> Result<String, JsValue>
//
//   returns JSON:
//   {
//     "global": {
//       "txVersion": u32, "versionGroupId": u32, "consensusBranchId": u32,
//       "expiryHeight": u32, "coinType": u32,          // 133 mainnet / 1 testnet
//       "fallbackLockTime": u32|null,                  // null = absent Option
//       "txModifiable": u8                             // REQUIRED, not optional
//     },
//     "orchardBundle": {                                // null if no orchard bundle
//       "flags": u8, "valueBalance": "<i64 decimal>", "anchor": "<hex>",
//       "actions": [ {
//         "cvNet","nullifier","rk": "<hex>",
//         "spendRecipient": "<43-byte hex>", "spendValue": "<u64 decimal>",
//         "spendRho","spendRseed": "<hex>", "alpha": "<32-byte hex>",
//         "signingPath": "32'/133'/0'",                 // zip32 path STRING (not an array)
//         "seedFingerprint": "<32-byte hex>",
//         "cmx","ephemeralKey","encCiphertext","outCiphertext": "<hex>",
//         "recipient": "<43-byte hex>", "value": "<u64 decimal>",
//         "rseed": "<hex>", "rcv": "<32-byte hex>"
//       }, ... ]
//     }
//   }
//
// - consensusBranchId / expiryHeight come straight from the parsed pczt global
//   (do NOT hardcode - they change per network upgrade and feed the sighash).
// - signingPath / seedFingerprint come from each action's zip32_derivation.
// - Reject V6/ironwood bundles here (return an error) - orchard-V5 only.
// - Re-vendor per packages/zcash-wasm/BUILD_PROVENANCE.md after adding it.
