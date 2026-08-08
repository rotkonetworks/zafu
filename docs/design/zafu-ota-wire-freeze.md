# Zafu OTA wire contract — frozen implementation notes (v1)

Implementers: the normative spec lives in `docs/design/zigner-firmware-ota.md` and
`docs/design/zigner-ota-rfc.md`. This file records the *concrete* decisions that make
the two sides match byte-for-byte. The golden corpus is
`apps/extension/src/ota/test-data/test-vectors.json` (TS, zafu) and
`rust/ota/test-data/test-vectors.json` (Rust, zigner) — identical file.

## Canonical CBOR (RFC 8949)
- Maps: definite length, integer keys in **ascending** order.
- Integers: minimal canonical encoding (0x00..0x17 for 0..23, then 0x18..).
- Strings/byte-strings: definite length only; byte-strings use `payload_len`-prefixed.
- Booleans: 0xf5 / 0xf4.
- Reject: trailing bytes, duplicate keys, indefinite lengths, non-minimal ints.

## Domain tags (prefix of the signed message). FREEZE including the leading 0x00.
- manifest `00 zafu/manifest/v1`
- image    `00 zafu/image/v1`
- result   `00 zafu/result/v1`
- status   `00 zafu/status/v1`

Signed message = tag_bytes || canonical_CBOR(...). **The 0x00 is part of the signed bytes.**

## Field schemas (maps, integer keys)
Manifest signed set (fields 1..7):
```
1 version(tstr)  2 board(tstr)  3 payload_sha256(bstr 32)
4 payload_size(uint)  5 min_version(tstr)  6 key_id(uint)  7 class(tstr "release"|"rollback")
```
Full manifest frame[0] adds (un-signed): `8 image_sig(bstr 64)` `9 req_id(bstr 8)`.

Image signed set (field numbers are this map, NOT the manifest numbers):
```
1 key_id(uint) 2 board(tstr) 3 version(tstr) 4 payload_sha256(bstr 32) 5 payload_len(uint)
```

Result (device->wallet), fields 1..6:
```
1 fw_version(tstr) 2 success(bool) 3 slot(tstr "A"|"B") 4 req_id(bstr 8)
5 zid_pubkey(bstr 32) 6 result_sig(bstr 64)  # 6 not in signed set (signed = 1..5)
```

Status (reconciliation, device->wallet), fields 1..5:
```
1 fw_version(tstr) 2 slot(tstr) 3 successful_boot(bool) 4 zid_pubkey(bstr 32)
5 status_sig(bstr 64)  # 5 not in signed set (signed = 1..4)
```

Image wire wrapper (frame[1..n], NOT CBOR, NOT signed):
`u32le key_id || u32le payload_len || sha256(payload)||payload_bytes` (32B sha256).

root_recommended: 0

## Ed25519
- RFC 8032 strict verify (reject non-canonical S, small-order/identity pubkey at pin).
- Both sides pin `ota_sign_public_key_hex` from the corpus (dev placeholder; real HSM
  key is production burn-in, out of scope). key_id blacklist checked but empty in dev.
- Wallet verifies manifest_sig + image_sig against pinned key; never signs.
- Device signs result/status with its zid identity key (result zid_pubkey's private).

## UR framing
- `ur:zafu-stream` = BC-UR fountain of `[manifest_cbor || image_wrapper]`, type
  `zafu-stream`, fragmentSize 400. Manifest is at byte offset 0 of the reassembled
  buffer; device validates it there before staging.
- `ur:zafu-result` / `ur:zafu-status` = single-segment UR (fits one QR, <= ~200B).

## Semver ordering (RFC §5, §7.1) — NORMATIVE
- Numeric component-wise major.minor.patch compare only; reject `v` prefix and
  prerelease/build suffixes. No lexicographic compare. (reference in corpus impls)

## Anti-rollback / applicability (device)
- reject blacklisted key_id, wrong board, unknown class, version < min_version,
  version <= current applied version (monotonic; rollback class only permitted via
  explicit windowed device-local menu, NOT on the wire).
