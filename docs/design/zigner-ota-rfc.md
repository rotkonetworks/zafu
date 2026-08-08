# Zinger OTA over QR — Implementation RFC

**Status:** 1.0 (implementation surface only). Rationale/threat model live in
`zigner-firmware-ota.md`. This file is the normative wire contract.

Two output artifacts required before implementation is accepted: (a) HSM-signed
**signature test vectors**; (b) confirmation of **signature-enforcing verified boot**.

---

## 1. Trust anchor
- Ed25519. One pinned **Zafu update public key**, burned into device firmware and
  extension. Never fetched over the network.
- `key_id` (uint) in every signature. Reject blacklisted `key_id`.
- Strict Ed25519 verify (RFC 8032): reject non-canonical `S`, reject small-order /
  identity public key at pin time. Constant-time compares.

## 2. Canonical CBOR + signatures (FREEZE — both sides must match byte-for-byte)
- Serialize with tagged CBOR (RFC 8949): maps with **ascending integer keys**,
  definite-length strings, no indefinite lengths, no trailing bytes, no duplicated
  keys. Length-prefixing comes from CBOR itself (no raw string concat, ever).
- Domain tags:
  `manifest` = `\x00zafu/manifest/v1`
  `image`    = `\x00zafu/image/v1`
  `result`   = `\x00zafu/result/v1`

```
manifest_sig = ed25519( "zafu/manifest/v1"
       || canonical{ version, board, payload_sha256, payload_size, min_version, key_id, class } )
image_sig    = ed25519( "zafu/image/v1"
       || canonical{ key_id, board, version, payload_sha256, payload_len } )
result_sig   = ed25519( "zafu/result/v1"
       || canonical{ fw_version, success, slot, req_id, zid_pubkey } )
```
- These are the ONLY signed forms. `req_id` is never signed.

## 3. Wire — `ur:zafu-stream` (wallet → device, one fountain flight)
```
frame[0] = manifest (canonical CBOR, signed above)
  { 1: version, 2: board,
    3: payload_sha256,      # 32B hex, full image
    4: payload_size,        # uint bytes
    5: min_version,
    6: key_id,
    7: class,               # "release" | "rollback" — SIGNED, whitelist
    8: image_sig,           # 64B hex
    9: req_id }             # 8B, session correlation only (NOT crypto)
frame[1..n] = image wrapper:
  u32le key_id || u32le payload_len || sha256(payload) || bytes(payload)
```
Rules: device verifies `manifest_sig` + `image_sig` against pinned key BEFORE any
staging write. Frame[0] is the manifest — the approved content is bound to the stream
by construction. `req_id` mismatches are ignored (replay of a signed image is not an
attack; version ordering §5 is the replay/downgrade backstop).

## 4. Wire — `ur:zafu-result` (device → wallet, tiny, DEVICE-SIGNED)
```
{ 1: fw_version,
  2: success,    # bool
  3: slot,       # 'A'|'B'
  4: req_id,
  5: zid_pubkey,
  6: result_sig }   # ed25519 "zafu/result/v1" over (1..5)
```
Emitted ONLY after the new slot has durably confirmed `successful-boot`. Single frame,
≤ ~200 B. Wallet verifies `result_sig` against `zid_pubkey`.

## 5. Version ordering (NORMATIVE)
Canonical numeric component-wise semver compare (major.minor.patch; reject `v` and
prerelease in these fields; no lexicographic/locale compare). Both sides identical.

## 6. Device behavior (summary)
1. Scan stream: verify `manifest_sig`; reject blacklisted `key_id`, wrong `board`, bad
   `class`, `version` ordering violation (§5). Mismatch ⇒ discard, no reply.
2. If applicable: write inactive slot, verify per-chunk hashes; on completion verify
   `image_sig`. Any failure ⇒ discard inactive slot.
3. Human tap → mark `successful`-pending → reboot → verified boot → switch; fail ⇒
   auto-rollback to prior slot.
4. After durable `successful-boot` → emit signed `ur:zafu-result`.

## 7. Framing / size
- BC-UR bytewords + fountain. Fragment ~400 B/frame.
- Image ≤ ~250 KB for v1 (≈1 min scan). Fountain redundancy ~10–20%.
- Re-scan resumes safely (A/B); wallet cycles the fountain until device stops.

## 8. Hard requirements (before v1)
1. Real HSM key burned in (no placeholder/configurable key).
2. Signatures only over the §2 canonical forms; test-vector corpus both teams match.
3. Signature-enforcing verified boot + persistent recovery slot.

## 9. Rollback
Device-local, human-tapped menu switch to prior slot, window-bounded (12 h or first
verified boot). No wallet→device rollback message exists. Owner-retention is an option;
revocation of compromised (version, key_id) rides on the next signed upgrade. OPTIONAL —
not required for the core wire contract above.
