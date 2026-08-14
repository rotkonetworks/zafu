# Releasing zafu

Three release lanes, one philosophy: **pin the SHA/artifact, verify, promote -
and never let CI be the _sole_ signer of anything that can touch a user's seed.**

| Lane               | What                                                                   | Signed by                                           | CI's role                                               |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Extension          | the Chrome extension (CRX)                                             | CI-held CRX key (`zafu-prod.pem` / `zafu-beta.pem`) | build + sign + publish                                  |
| Low-stakes content | voting config, feature payloads (online-only)                          | CI key (or keyless attestation)                     | build + sign + publish                                  |
| **Firmware OTA**   | zigner signed modules (run on the air-gapped device, **get the seed**) | **2-of-3 FROST** (CI = 1 async share)               | build + **complete** a human-presigned 2-of-3 + publish |

Why the split: a bad extension is recoverable (uninstall, re-push, CWS review).
A bad firmware module is not - it receives the raw mnemonic
(`module_host` writes the seed into the loaded module) and its output crosses
the air-gap, so it can exfiltrate the seed. The signature is the _only_ thing
protecting that, so CI must never be able to produce it alone.

---

## Lane 1: Extension (beta -> prod)

Beta **leads and soaks**; prod **promotes the exact soaked commit**. They are
separate CWS listings (prod `oojfeopgoeapfgcfhmlpfgabcbhkglck`, beta
`ppgbkpjgpggkibdojjocgndbbhiempjf`) with separate signing keys.

```
main (dev)
  └─ tag  vX.Y.Z-beta.N  at a pinned, reviewed SHA   → CI: beta-only  → Beta listing  [SOAK]
        │  smoke test on beta: zigner send, voting cast, address derive, console clean
        │  bug? fix on main → -beta.(N+1) → re-soak
        ▼  (green)
     tag  vX.Y.Z  at the SAME commit the beta passed → CI: prod-only  → Prod listing  [PROMOTE]
```

Two properties this gives you that "tag once, publish both" does not:

1. **Decoupled in time** - beta ships first and soaks; prod never fires simultaneously.
2. **Prod = the proven artifact** - the clean tag points at the exact commit beta
   validated. You do not rebuild a newer, untested `main`.

### How to trigger (`release.yml`)

- **Tag push:** `git push origin vX.Y.Z-beta.1` (beta) then, after soak,
  `git push origin vX.Y.Z` at the same commit (prod).
- **Manual dispatch** (Actions -> "Release"): `tag_name` cuts + pushes the tag at
  the current commit; empty `tag_name` = dry-run (build only). `channel` overrides
  `auto`/`beta-only`/`prod-only`/`both`/`skip`. Dispatch is the cleaner promotion
  path - pick the channel explicitly.

### Channel routing (auto)

- prerelease tag (`alpha|beta|rc`) -> `beta-only`
- clean tag (`vX.Y.Z`) -> `prod-only` _(promotion; beta already shipped from -beta.N)_

### Version discipline (CWS gotcha)

CWS rejects re-uploading the same version to a listing. So each `-beta.N` needs a
**distinct** manifest version on the beta listing (e.g. `26.0.0.1`, `26.0.0.2`);
the clean tag ships `26.0.0` to prod. TODO: stamp the manifest version from the
tag in CI so `beta.2` cannot collide with `beta.1`.

### RC freeze (optional, for big releases)

`vX.Y.Z-rc.N` routes beta-only for free (the `rc` regex). Convention: after
`-rc.1`, feature-freeze; bug-fixes only until the clean tag.

---

## Lane 2: Low-stakes signed content

Voting config, feature payloads, anything that only affects the **online**
extension and never the air-gapped device: **full CI signing is fine** (or
keyless Sigstore/OIDC attestation for provenance). Same trust level as the CRX.

---

## Lane 3: Firmware OTA (2-of-3 FROST, CI = one async share)

The one lane where CI must not be able to sign alone. Model is Nova's Metadata
Portal shape (single logical signer, offline), hardened to a threshold because a
zigner module - unlike Polkadot metadata - **holds the seed** (no consensus
backstop like `CheckMetadataHash` to reject a malicious module).

### Shares (2-of-3 FROST; no party holds 2)

- **CI** - one share, used to _complete_ a human-presigned signature. Stored
  age-encrypted; the age identity that unlocks it lives on the CI runner ONLY as
  the completion share, never the whole key.
- **Release manager** - one share, presigns locally/offline (YubiKey/air-gap).
- **Cold backup** - one share, second maintainer/offline, for recovery.

Property: **CI compromise leaks one share, useless without the release manager's
presign.** CI cannot forge firmware alone. No live ceremony - the release manager
presigns async, CI completes at publish.

### Flow

1. Build produces the firmware **manifest** (module bytes + version + trust-anchor
   set). Deterministic; committed for review.
2. **Release manager reviews the manifest and presigns their FROST share offline**
   (bound to _these_ bytes - CI cannot reuse the share for a different payload).
   This is also the human attestation to the exact firmware.
3. CI (`ota-release.yml`, on `ota-*` tags) contributes its share -> aggregates the
   2-of-3 -> attaches the signed module to a GitHub Release and/or the OTA endpoint.
4. Device + `zafu` verify the aggregate signature against the **pinned group
   public key** (unchanged verifier; the `module_host` kernel trust anchors).

### Second layer (defense in depth)

The **faithfulness / display<->sighash binding** (per-tx anchor attestation
against the verifier key) stays in fixed firmware. Even a mis-signed module
should not be able to decouple what the user confirms from what is signed.

---

## The swarm rule (coordination)

Multiple sessions/agents may be committing to `main`. **Releases pin a chosen
SHA; they do not chase the tip.** Before cutting `-beta.N`, pick a reviewed SHA
and make sure other sessions are on feature branches, not writing the release
SHA out from under you. One owner per release.

## The one invariant

CI is a **builder / verifier / publisher / threshold-completer** - never the sole
signer of anything that can move funds or reach the seed.
