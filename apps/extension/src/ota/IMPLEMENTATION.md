# Zafu OTA wallet-side — implementation status (wire v1)

Implements the ZAFU (browser-extension) half of the Zafu/Zigner OTA spec.
Normative specs: `docs/design/zigner-firmware-ota.md`, `zigner-ota-rfc.md`,
`zafu-ota-wire-freeze.md`. Golden corpus: `apps/extension/src/ota/test-data/test-vectors.json`
(identical to the zigner `rust/ota` copy — freeze contract; do not modify without
regenerating BOTH copies identically).

## What's implemented (verified)
- `canonical.ts` — strict canonical CBOR (RFC 8949) encode + strict decode (rejects
  trailing bytes, dup keys, indefinite lengths, non-minimal ints).
- `semver.ts` — normative numeric component-wise compare; rejects `v`/prerelease.
- `signature.ts` — ed25519 verify via @noble/curves, RFC 8032 strict (rejects
  non-canonical S, small-order/identity pubkey at pin). verifyManifest/Image/Result/Status.
- `keys.ts` — pinned OTA pubkey + KEY_ID_BLACKLIST (empty in dev) + BOARD.
- `types.ts` / `stream.ts` — manifest/image/result/status types + full stream
  verification (sig, blacklist, board, class, anti-rollback, trailing image wrapper,
  per-chunk hash), module-size cap.
- `ur.ts` — BC-UR fountain encode of `ur:zafu-stream`, decode of `ur:zafu-result`/status.
- `session.ts` — wallet state machine idle→streaming→awaiting_tap→awaiting_result→recorded,
  timeouts + abort.
- `store.ts` + `state/ota.ts` — device firmware record keyed by zid_pubkey; only a
  device-signed verified `ur:zafu-result` mutates it. Slice registered in `state/index.ts`.
- `feature.ts` — fail-closed feature gating from verified version→capability map.
- UI: `routes/popup/settings/settings-ota.tsx` (registered in routes.tsx + settings.tsx
  under `PopupPath.SETTINGS_OTA`): check-for-update → verify → "signed & verified —
  upgrade?" Y/N → animated QR stream → scan result → verify → record.
- Tests: `ota.test.ts` 22/22 pass (canonical byte-for-byte vs corpus, positive/negative
  sig verify, semver matrix, UR round-trip, stream rejection gates).
- Type-check: `pnpm exec tsc --noEmit -p apps/extension/tsconfig.json` clean.

## Design decision (product, 2026-08)
OTA target = the SMALL signed MODULE layer (1–3 MB wasm, QR ~1–2 min), NOT a whole
firmware/kernel replacement (which is a store/USB path). UI presents "protocol module
update". See IMPLEMENTATION.md context + `zafu-ota-wire-freeze.md`.

## Known gaps / notes
- The pinned key + all signatures are DEV-PLACEHOLDER identities. Real HSM burn-in +
  manifest-sig-on-wire placement are production gates (spec §3.1/§11.2); the frozen
  wire keeps image_sig inline (frame0 field 8) and passes manifest_sig via the carrier.
- Rotation/revocation receipts and the wallet "adopt rotated key" path are designed
  but not wired as a separate payload (they ride the next signed upgrade per spec).

## Delivery pipeline — NOW REAL in zafu (added 2026-08)
The "1-3 MB module over QR" was receiving-only; the producer/delivery is now wired:
- `producer.ts` — dev producer builds a fully-signed `ur:zafu-stream` (canonical CBOR
  manifest fields 1..9, image_sig, image wrapper) from a module/wasm file using the
  dev key. `producer.test.ts` (4 tests) proves a real ~2 MB stream verifies against the
  pinned key, round-trips the BC-UR fountain, and that TAMPERED payloads are rejected.
- **Payload-integrity fix**: `verifyStream` now recomputes SHA-256 of the delivered
  payload bytes (`sha256Sync` in util.ts) and compares to the signed payload_sha256 —
  it previously trusted the wrapper's declared hash, so a corrupted payload could pass
  "signed & verified". This mirrors the device-side `verify_payload_chunks`.
- `scripts/ota/ota-dev-server.mjs` + npm scripts `ota:pack` (generate dev-stream.json)
  and `ota:serve` (serve it at the OTA_FETCH_URL) — so the Settings OTA screen's
  "check for update" actually resolves in dev.
