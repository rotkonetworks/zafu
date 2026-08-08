# Zinger Firmware Update over QR — Offline Seamless (A/B) OTA

**Status:** 1.0.4 — 2-RTT simplification adopted from the security review (HTTP/1.1-style: drop offer/accept/rollback turns; the signed image is the single authority).
**Author:** Zafu engineering
**Scope:** wallet-side (`apps/extension`) + prototol contract the zinger device
firmware MUST implement. The device firmware is out of repo; this document fixes
the wire contract it must honor.

> Style: threat model first, defense in depth, fail-closed. Every assumption is an
> attack surface until proven otherwise. Two independent teams (wallet and device)
> must be able to implement this and match byte-for-byte. Where a section says
> "pin/freeze," it is normative and gating for v1.

---

## 1. Goals and non-goals

### Goals

- Deliver signed zinger firmware updates to a device that **never touches the
  network**; the only physical channel is QR codes.
- Device stays **offline** for the full lifecycle: fetch, verify, stage, apply,
  roll back.
- Updates are **seamless (A/B)** and **human-gated**: nothing is committed until a
  person taps the device; a bad update does not strand the device.
- Wallet-side UX is one trustworthy decision: _"signed & verified — upgrade? Y/N"_,
  then hold the phone up.
- **Authenticity is a hard property**, verified end-to-end at the device.

### Non-goals

- Confidentiality of the firmware image (public signed data; not encrypted).
- Real-time OTA / push. The wallet initiates.
- Downgrade to arbitrary versions (see §7 downgrade policy).
- Multi-device parallelism / server-side resumability (A/B makes rescan the recovery).

---

## 2. Threat model

### 2.1 Assets

- **Firmware integrity & authenticity** — the root of trust for everything the
  device signs. If firmware is replaceable at will, nothing else matters.
- **Device secrets** — seed, spending keys.
- **User funds** — signing-path availability & correctness.
- **User privacy** — tx/balance metadata; device identity (version/board/zid).
- **Device availability** — a bricked device is a lost wallet.

### 2.2 Attackers

- **A1** malicious/compromised firmware _server_ (tampered manifest/image; serves
  a _valid older_ image to downgrade).
- **A2** compromised Zafu extension / malicious website (can flip QR bytes or lie
  to the user about verification).
- **A3** network MITM on wallet↔server (DNS/TLS/Wi-Fi; swaps the download).
- **A4** QR-channel observer (sees the inbound firmware stream and the outbound
  accept/result QRs — leaks device state/version/board/identity).
- **A5** physical attacker with the device (cannot install firmware without
  breaking a signature).
- **A6** signing-key compromise (supply chain / insider; limited blast radius via
  key versioning + blacklist; detect, don't just prevent).

### 2.3 Trust boundaries

- **Device is the sole root of trust for firmware.** Holds the pinned Zafu update
  public key; verifies _everything_ it runs against it; never trusts wallet/server
  for authenticity.
- **Wallet is a semi-trusted, potentially-compromised client.** May fetch/display
  anything; must never make the device run something it can't verify.
- **Server is untrusted and mutable.** Tamper/MITM detected by signature at the
  device (and, for UX, at the wallet).
- **QR channel is public, one-way-at-a-time; no secrecy assumption.** Device
  identity leakage (A4) is treated explicitly (§11).

### 2.4 Design implications (violations we refuse)

1. No wallet re-signing / alteration of firmware; wallet only relays signed bytes.
2. Never show "signed & verified" unless the wallet itself verified against the
   pinned key.
3. Never apply on "download complete" — a human tap on the device is the commit.
4. Never rely on a nonce, class flag, or version we did not cryptographically bind.

---

## 3. Trust anchor, signature scheme, and ONE canonical serialization

### 3.1 Anchor

- **Ed25519**, a fixed **Zafu update public key** compiled into both device and
  extension. Pinned, never authenticated over the network.
- The real HSM-derived key is **burned in** before v1. A placeholder/configurable
  key is a supply-chain hole and is explicitly prohibited in a release build
  (§11 open review-gate).
- **Key versioning:** integer `key_id` in every signature. Rotation and
  blacklisting are defined in §3.4.

### 3.2 The single signed form (FREEZE THIS — gating)

All signatures are over **tagged, canonical CBOR** (RFC 8949) with fixed field
numbers per map and **a fixed domain tag prefix**. Raw byte-concatenation is
FORBIDDEN for anything signed (it is not injective for variable-length strings).

- **Manifest tag:** `\x00zafu/manifest/v1`
- **Image tag:** `\x00zafu/image/v1`
- **Result tag:** `\x00zafu/result/v1`
- **Rollback tag:** `\x00zafu/rollback/v1` (unused on the wire — reserved for the
  optional revocation receipt in §3.4)

Canonical CBOR: maps with integer keys in ascending order, definite-length strings,
no indefinite lengths, length-prefixed by construction (CBOR strings carry their own
length, which is exactly what removes the boundary-ambiguity in §3.3). Both signer
(HSM) and verifier (device) MUST serialize identically. Ship a **signature test-vector
corpus** (produced off the HSM) that both implementations must match before v1 —
"works in CI only" is not acceptable.

`manifest_sig = ed25519( "zafu/manifest/v1" || canonical{version, board, class,
payload_sha256, payload_size, min_version, key_id} )` // fields 1..7; req_id NOT signed

`image_sig   = ed25519( "zafu/image/v1" || canonical{key_id, board, version,
payload_sha256, payload_len} )`

There is exactly **one** definition of each. Remove any other wording. The image*sig is
over the signed \_image header* field set above (NOT over manifest field numbers 1..4) —
keep §3.2 and §5.2 in lockstep here; do not introduce a second spelling.

### 3.3 Verification strictness

- Reject **non-canonical-S** signatures and the **small-order / identity public
  key** at pin time (RFC 8032 strict verification).
- Reject any byte stream that is not byte-exact canonical (defensive parsing:
  no trailing bytes, no duplicated CBOR keys, no indefinite lengths).
- Constant-time comparisons for hashes and signature verification.

### 3.4 Key rotation & blacklist (no circularity)

- **Rotation:** a _new_ anchor may be installed only by a firmware image signed by
  the _current_ anchor (the existing signed root is the only thing allowed to
  change the root). Rotation mints a signed **rotation receipt** the wallet can
  ingest so the extension also adopts the new key and continues to show
  "signed & verified."
- **Blacklist:** a leaked `key_id` is revoked through an **out-of-band revocation
  channel** (HSM/audit signed update), NOT solely by a release signed with the
  leaked key (that is circular). Device and wallet reject blacklisted `key_id`s.
- Rotation/revocation receipts carry their own `signed_at` and `class`, and are
  themselves strictly canonical.

---

## 4. A/B (seamless) update on the device

- Two slots A/B with bootloader-managed `slot-count` / `successful-boot` markers.
- **Staging:** new firmware writes to the **inactive** slot; the running slot is
  never touched during transfer. A corrupt/partial inactive slot is harmless.
- **Activation:** only on an explicit human tap; then reboot; the new slot is NOT
  considered durable until its _own_ firmware, after boot, confirms
  `successful-boot`. Until then the next reboot auto-rolls-back.
- **Rollback:** a device-local, human-prompted switch to the prior slot, allowed
  ONLY within the **rollback window** (§7.2). There is NO `ur:zafu-rollback` wire
  message (removed in 1.0.4) — the only human at the device can flip a slot.
- **Why load-bearing for the protocol:** staging is non-destructive + self-healing
  (rescan until the inactive slot has enough valid fountain frames) ⇒ **no
  per-chunk ACK layer**; responses stay tiny.

---

## 5. QR protocol — wire contract (2 UR types, 2 RTTs)

The internal review found most of the small UR turns existed only to "negotiate" things
the signature plus self-healing staging already decide. The design cuts to **two UR
types**, **two round trips**, and **zero unauthenticated wire commands**:

- `offer` is folded into the stream: the **first fountain frame IS the signed
  manifest**, so there is no separate offer handshake (headers + body in one flight).
- `accept` is deleted: a device that doesn't want a stream simply discards it —
  fountain is self-healing and staging is non-destructive, so an unwanted stream
  costs nothing and "didn't want it" needs no wire message. Applicability is decided
  from the **signed** first frame while scanning.
- `rollback` is deleted from the wire: it becomes a **human-prompted switch inside the
  device's own update menu**, bounded by the rollback window (§7.2). One UR type gone,
  one attack surface gone.

### 5.1 Framing & size discipline

- UR / BC-UR bytewords + fountain, matching existing zinger UR types.
- **The only device→wallet QR on the nominal path is `ur:zafu-result`, single-frame and
  tiny (≤ ~200B payload, enforced by schema).** The sole optional exception is
  `ur:zafu-status` (§9.2), used only for lost-result reconciliation — not part of the
  2-RTT path, so it does not count against the minimal wire surface.

### 5.2 UR types & CBOR schemas (freeze before v1)

**`ur:zafu-stream`** (wallet → device, ONE fountain flight)

```
frame[0] = signed manifest (canonical tagged CBOR):
  { 1: version,          # semver string
    2: board,
    3: payload_sha256,   # 32B hex full-image hash
    4: payload_size,     # uint bytes
    5: min_version,
    6: key_id,           # uint
    7: class,            # "release" | "rollback"  (SIGNED — be strict)
    8: image_sig,        # 64B hex
    9: req_id }          # 8B session-correlation id (NOT crypto; see §5.4)

frame[1..n] = canonical image wrapper:
  u32le key_id || u32le payload_len || sha256(payload) || payload_bytes

manifest_sig = ed25519( "zafu/manifest/v1" || canonical(1..7) )   # domain-separated
image_sig    = ed25519( "zafu/image/v1"    || canonical{key_id, board, version, payload_sha256, payload_len} )   # §3.2 image-header set, same serializer
```

- **One** canonical tagged-CBOR serializer (RFC 8949, integer keys ascending, definite
  lengths, strict parse: no trailing bytes / dup / indefinite). Length-prefixing by CBOR
  construction removes boundary ambiguity.
- Both signatures verified by the **device** (and, for the Y/N UX, by the **wallet**)
  against the pinned key **before** any staging write.
- Because the manifest is frame[0] of the same signed flight, the stream is **bound to
  the approved content by construction** — there is no separate offer to drift from.

**`ur:zafu-result`** (device → wallet, tiny, DEVICE-SIGNED)

```
{ 1: fw_version,
  2: success,      # bool
  3: slot,         # 'A'|'B'
  4: req_id,
  5: zid_pubkey,
  6: result_sig }  # ed25519 "zafu/result/v1" over (1..5)
```

Emitted only after the new slot has **durably confirmed `successful-boot`** (§4), never
merely on "active." The wallet verifies `result_sig` against `zid_pubkey` so the §8
feature record updates from something genuinely verified.

### 5.3 Round trips

| step     | direction             | UR            | size                | device role                                                                        |
| -------- | --------------------- | ------------- | ------------------- | ---------------------------------------------------------------------------------- |
| check    | wallet↔server         | —             | n/a                 | offline device                                                                     |
| stream   | wallet→device         | `zafu-stream` | large, self-healing | decide from signed frame0; stage to inactive slot; verify manifest_sig + image_sig |
| apply    | device local          | —             | human tap           | durable only after successful-boot                                                 |
| result   | **device→wallet**     | `zafu-result` | **tiny**            | signed durable-state report                                                        |
| rollback | **device local menu** | —             | —                   | human-prompted slot switch within window                                           |

Two RTTs total (stream in, result out); everything else is local on the device.

### 5.4 Correlation vs replay (exact)

- `req_id` is for **session correlation** only (8B, not crypto): it lets the wallet match
  a `result` to the stream it pushed. It is NOT a security primitive.
- **Image replay is not an attack:** a replayed _signed_ image is still a valid signed
  version; authenticity is intact. Replay-as-downgrade is closed by **version monotonicity
  (§7.1)** plus the signed `class`/`min_version`, not by nonce/req_id.
- Freshness of rollback-class releases is bounded by the signed `class` + `min_version`
  policy (§7.2); no clock on the device is required.

## 6. The wallet does not vouch; the device verifies

### 6.1 Wallet-side (for a truthful Y/N)

Wallet fetches `ur:zafu-stream` bytes from the server, verifies `manifest_sig` + `image_sig`
against the pinned key and rejects blacklisted `key_id`, **before** showing
"signed & verified" and before displaying the stream. Fails → "no verified update", send
nothing. A compromised wallet can still lie to the user; the device verifies (§6.2).

### 6.2 Device-side (the load-bearing gate)

1. While scanning frame[0], verify `manifest_sig`; reject blacklisted `key_id`, wrong
   `board`, bad `class`, version order violation (§7.1). Mismatch ⇒ discard, no wire reply.
2. If applicable, continue scanning; write to the inactive slot verifying per-chunk hashes;
   on completion verify `image_sig`. Any failure ⇒ discard inactive slot, no state change.
3. Human tap → mark inactive `successful`-pending → reboot → verified-boot boots it →
   switch; on failure auto-rollback.
4. After durable `successful-boot`, emit device-signed `ur:zafu-result`.

## 7. Downgrade & rollback policy (fail-closed)

### 7.1 Version ordering is NORMATIVE

Pin a canonical **numeric component-wise semver compare** (major.minor.patch; reject
`v`/prerelease for these fields; no lexicographic/locale compare). Both sides implement
identically. This plus the signed `class`/`min_version` is the replay/downgrade backstop.

### 7.2 Rollback: device-local, windowed, owner-settable — OPTIONAL, not on the v1 wire

Rollback is a **local device action** — the user, in physical possession of the zinger,
opens its own update/recovery menu and taps "revert to previous version." There is **no
wallet→device rollback command** and no server lever; the only human at the device can
flip a slot. The wallet's only role is cosmetic (show a "revert available until <boot>"
hint from its §8 advisory record — UX-only, never authority). This makes remote
downgrade structurally dead: A1/A2 have no slot switch to exploit.

**Bootloader window state machine (normative):**

```
activate(new_slot):
  prior_slot = active; active = new_slot; mark new_slot boot-pending
  window_open = now
on_successful_boot():            # new slot firmware confirms successful-boot
  window_open = none             # window also closes at first verified boot
  prior_slot.inert = true
on_revert(menu tap):             # only while window_open (≤ 12h AND no successful-boot yet)
  if !window_open or target_slot.inert: reject
  active = prior_slot; re-run on_successful_boot for it (prior slot is signed+previously-booted)
after 12h:                       # if no successful-boot and no revert
  window_open = none; prior_slot.inert = true
```

- Old-slot retention is a **user/owner setting** (window value, default 12h): their
  device, their call — not a crypto-policy nanny, because a physical owner rolling back is
  not an attacker (that is the PIN threat, out of OTA scope, §11.3). The window is always
  finite (12h or first verified boot, whichever first), so there is never a standing
  "roll back to anything" path; prior slot stays **signed, previously-booted** (switching
  slots installs nothing unsigned).
- **Signed revocation of compromised old versions (supply-chain half):** the Zafu signer
  can _expire_ a known-critical-vuln `(version, key_id)` by signing a small revocation
  that rides on the next normal upgrade the device pulls (fully user-tapped, not a push,
  not remote control). The device blacklists it from ever being a rollback/install target.
  This is also the non-circular fix for the earlier key-blacklist concern (§3.4):
  revocation travels on the next signed upgrade, not on the compromised key.
- **Proportionate scope:** the only downgrade that could matter is a _physical_ attacker
  rolling a PIN-protected device back to an old build with a known seed-extraction bypass.
  The window + revocation close that; a physical owner who can already operate the device
  is out of OTA scope by definition.

### 7.3 `class:"rollback"` is signed

A rollback-class image must satisfy: signed (`image_sig` + `manifest_sig`), whitelisted
`class`, `version >= min_version`, and the §7.1 ordering. `class` lives ONLY inside the
signed canonical manifest (field 7); an unsigned `class` never exists in this protocol.

## 8. Device firmware state held by Zafu (feature-set awareness)

### 8.1 What Zafu stores

Per-device (keyed by `zid_pubkey`), in encrypted local state:

```
{ device, fw_version, slot, feature_set, applied_at,
  source: "ur:zafu-result",  // set ONLY from a DEVICE-SIGNED, verified result
  session: <req_id> }        // last matched stream id for reconciliation (§9.2)
```

### 8.2 Gating & UX

- Gate wallet features on device capability (`feature_set` from version map).
- Don't re-offer an already-applied update.
- Show real device firmware info in Settings (from verified state only).

### 8.3 Advisory, not a trust boundary (fail-closed)

Routing/UX only; the device enforces for itself. Unknown/stale version ⇒ **no capabilities
offered**, never assume. A claimed-but-unverified state never mutates the record (only a
device-signed `ur:zafu-result` does).

## 9. State machine, sessions, timeouts, reconciliation

### 9.1 Lifetime & timeouts (normative)

`idle → streaming → awaiting_tap → awaiting_result → recorded`, with explicit per-state
deadlines (e.g. stream staleness, result timeout ~120s) and an **abort** path that leaves
the running slot untouched. A device that discards a stream (decided in §6.2) simply never
sends a result; the wallet shows "no update applied."

### 9.2 Lost-result reconciliation

If the device applies but the wallet never sees the `result` (lost QR / closed tab), the
monotonic device refuses the same version and the record goes stale. The wallet persists
`session (req_id)` + expected target version; on next open it offers a **device-status
QR** (`ur:zafu-status`, device-signed, tiny: current `fw_version/slot/successful-boot`
excerpt) to reconcile instead of guessing.

## 10. Physical-channel sizing

- Max QR ~2953B (v40 low EC); practical animated frames ~400B/frame (`fragmentSize=400`).
- Fountain redundancy ~1.1–1.5×; use ~10–20% (`zt_encode_frames_auto` knob).
- The signed frame[0] manifest (field 4 `payload_size`) + the image hash tell the device the target so "done" is
  defined by signed data, not an unauthenticated prefix.
- Budget: 100 KB ≈ ~250–300 frames ≈ **~1 min**; 1 MB ≈ ~10 min. **Keep firmware ≤
  ~250 KB for v1;** validate with the device team. The device resumes by rescanning (A/B
  safe); wallet cycles the fountain indefinitely.

---

## 11. Privacy (A4) and remaining review-gates

### 11.1 Device-identity leakage

`zid_pubkey`, `board`, `fw_version`, `slot` cross the QR channel in plaintext on
device→wallet messages. Anyone who can see a screen learns the device identity and
version. Treat this as a **known, disclosed disclosure**; do not route secrets over it.
If it's unacceptable, route device→wallet messages only on user-initiated scans and
keep them single-frame, and drop `zid_pubkey` from the device→wallet reports where it
is not needed (keep it only in `result`, which the wallet needs for attribution).

### 11.2 Externally-vetted preconditions for v1 (open → gating)

From both reviews; these ship **before** v1, not as nice-to-haves:

1. **Burn in the real HSM-derived update key** (no placeholder/configurable key).
2. **Signature test-vector corpus** both wallet and device implementations must match.
3. **Signature-enforcing verified-boot bootloader** + a persistent **recovery slot**
   (A/B flags alone are not sufficient recoverability).
4. Signature-enforced boot + recovery slot as **hard preconditions**.

### 11.3 Threat-model additions

- Model a **compromised phone/display at Y/N-tap time** explicitly (mitigation = the
  device's independent verification — say so, don't assume).
- Model the signing HSM sharing an air-gapped box with a hostile build (custody/audit).

---

## 12. Open items to confirm with the device team

1. Freeze the §3.2 canonical CBOR + tags + test vectors (GATING).
2. Confirm the device supports signature-enforced verified boot + recovery slot (§11.2).
3. Real firmware size budget (§10) and whether a rollback-window flag is implementable
   on-device (§7.2).
4. Production manifest URL + the burned-in update key (both stubbed in dev only).
5. Match existing device `ur:` types / CBOR if any (deviation = breaking change).
6. Device-signed `accept`/`result` key: is `zid_pubkey` a usable signing key, or must a
   dedicated attestation/update key be provisioned?

---

## 13. Non-goals restated

- Privacy of when/which device updates (deferred; discussed §11.1).
- Post-quantum signature (deferred; Ed25519 with key-versioning and replaceable anchor).
- Firmware encryption (public signed data; no benefit over signature).

---

## Appendix A — Review findings & resolutions (v1.0 → v1.2)

Both reviews (protocol: hdevalence; security: redshiftzero) independently converged.
Every finding below is resolved in the text above. A17 records the review-introduced 2-RTT simplification.

| #   | Severity | Finding                                                                          | Resolution (this doc)                                                                                                                                                                        |
| --- | -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | CRIT     | Signed region defined 3 ways; not implementable to match                         | §3.2 freezes ONE canonical tagged-CBOR form + tags + test-vector corpus                                                                                                                      |
| A2  | CRIT     | Non-injective raw string concat (boundary ambiguity)                             | §3.2 CBOR length-prefixing + domain tags, byte-exact canonical; §3.3 strict parsing                                                                                                          |
| A3  | HIGH     | `class:rollback` outside signed manifest ⇒ downgrade gate a flag                 | §5.2 field 3 + §7.3: class signed, whitelisted, timestamped                                                                                                                                  |
| A4  | HIGH     | Signed image replay not stopped by nonce (overclaim)                             | §5.4 exact semantics: nonce=correlation+offer freshness; replay via monotonicity §7.1 + seen-offer cache                                                                                     |
| A5  | HIGH     | Semver ordering unspecified (compare can defeat monotonicity)                    | §7.1 pin normative numeric semver compare                                                                                                                                                    |
| A6  | HIGH     | accept/result/rollback unsigned; result lacks identity ⇒ forged "verified" state | §5.2 device-signed accept/result/rollback; result includes zid_pubkey; §8 only updated from device-signed result                                                                             |
| A7  | HIGH     | Stream not bound to the approved offer (approved v1.3, staged v1.2)              | §5.2: manifest is frame[0] of the same signed `zafu-stream` flight ⇒ bound by construction                                                                                                   |
| A8  | HIGH     | rollback unsigned/unbounded ⇒ downgrade + replay DoS                             | RESOLVED BY REMOVAL: rollback is device-local (no wire command). §7.2 window + owner-retention + signed revocation of compromised (version,key_id). A1/A2 downgrade vector structurally dead |
| A9  | MED      | "apply succeeded" ambiguous before successful-boot durable                       | §4 + §5.2 result emitted only after durable successful-boot                                                                                                                                  |
| A10 | MED      | No session/timeouts; lost result unrecoverable                                   | §9 session lifecycle, per-state timeouts, abort; §9.2 device-status reconciliation QR                                                                                                        |
| A11 | MED      | Stream completeness depends on unauthenticated prefix                            | §5.2: signed frame[0] manifest (field 4 payload_size) plus image hash; §10                                                                                                                   |
| A12 | MED      | Key rotation circular; placeholder key ships                                     | §3.4 rotation receipts + out-of-band revocation; §11.2 burn in real HSM key (gating)                                                                                                         |
| A13 | MED      | Brick avoidance depends on unconfirmed signature bootloader                      | §11.2 signature-enforced verified boot + recovery slot become hard preconditions                                                                                                             |
| A14 | MED      | A4 device-identity plaintext leakage                                             | §11.1 disclosed; optional minimize (drop zid from accept, keep in result)                                                                                                                    |
| A15 | LOW      | Section numbering / cross-ref drift; changelog could break tiny-QR               | renumbered once; changelog confined to offer side; tiny-QR ≤200B enforced by schema                                                                                                          |
| A16 | LOW      | `url` phishing vector / min_version direction                                    | §12 open item; `url` not part of any device→wallet schema; §5.2 class/min_version made explicit                                                                                              |

| A17 | HIGH (adopt) | Second review pass simplified the wire: fold offer into stream, delete accept, move rollback on-device | §5 2 UR / 2 RTT; §7.2 local windowed rollback; fewer turns, smaller surface |

**Aggregate verdict (both reviewers):** the device-as-root-of-trust and A/B
commit-on-tap model is right and kept. v1 as originally written did NOT satisfy the
signature/rollback/recoverability bars; after this revision the remaining gate is
external confirmation (§11.2, §12) plus freezing the canonical serialization (§3.2).
