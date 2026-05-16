# TODO: post-quantum hybrid transition — zid identities & encryption

Status: PLANNING. Captures the PQ-hybrid reasoning established for
quicnet (the rotko QUIC tunnel) and maps it to zafu's real crypto
surfaces. **Not yet started.** A code audit (step 0) gates any
implementation — specifics below are deliberately not assumed.

## Why (threat model)

Shielded-wallet traffic and stored ciphertext are long-lived and
attractive to **harvest-now-decrypt-later**: an adversary records
the zid channel / encrypted blobs today and decrypts when a CRQC
exists. Classical x25519 (what Noise uses) does not survive that.
Hybrid (x25519 ⊕ ML-KEM-768, concatenation/X-Wing combiner) does:
the session key is safe if *either* component holds. This is one
encryption with a hybrid-derived key — NOT double encryption.

Asymmetry to state honestly: this protects **confidentiality**
(retroactive). **Authentication** (identity signatures) staying
classical is a *real-time* forge risk only — it does NOT
retroactively expose recorded ciphertext. So confidentiality is
the priority; PQ identity-auth is a separate, lower-urgency, and
*non-standardized* problem (see step 3).

## CRITICAL difference from quicnet (do not skip)

quicnet got PQ cheaply: TLS 1.3 has a **standardized** hybrid group
`X25519MLKEM768` (rustls/aws-lc-rs) — a drop-in. **zid's Noise
channel has NO standardized PQ-hybrid drop-in.** Adding PQ to Noise
is a *deliberate hybrid-KEM construction* (PQ-Noise / combiner
design), higher risk than quicnet's one-line provider swap. Treat
it as a real crypto-design task: lean on audited primitives, a
vetted combiner, and ideally external review — do not hand-roll.

## Surfaces (grounded in the repo)

- `packages/zid/src/noise-channel.ts`, `noise-init-memo.ts`,
  `channel.ts` — the x25519 Noise channel between two zid
  identities. **Primary target.** Confidentiality of Zafu↔Zafu and
  Zafu↔Zigner channels.
- `packages/encryption/src/{encrypt,decrypt}.ts` — at-rest
  (standalone-mode spending keys, passphrase-wrapped). Symmetric
  (AES/ChaCha) is already PQ-adequate; only the **key-wrapping /
  KEM** part needs hybridization if it uses an asymmetric KEM.
- `packages/zid` identity signatures (ed25519) — the classical
  *auth* gap. Lower urgency (real-time only). PQ sigs (ML-DSA /
  SLH-DSA / Falcon) are NOT standardized into Noise or any
  drop-in here — explicitly out of scope for phase 1.

## Plan

- [ ] **0. Audit before anything.** Read `noise-channel.ts` /
      `noise-init-memo.ts`: exact Noise pattern, DH, rekey, and
      `packages/encryption` KEM/KDF. The plan below is provisional
      until this is done — do not implement on assumptions.
- [ ] 1. Pick audited PQ primitive: `@noble/post-quantum`
      (ML-KEM-768, audited, paulmillr) — the TS analog of the
      standardized choice; do not vendor unaudited PQ code.
- [ ] 2. Hybrid KEM combiner: x25519 ⊕ ML-KEM-768, X-Wing-style
      (transcript-binding concatenation combiner — same principle
      as rotko `falconed`). Confidentiality only, phase 1.
- [ ] 3. zid Noise channel: integrate the hybrid KEM into the
      handshake (PQ-Noise construction). Keep classical x25519 in
      the combiner for interop/fallback during transition.
- [ ] 4. at-rest (`packages/encryption`): hybridize key-wrapping
      only if it uses an asymmetric KEM; leave symmetric as-is.
- [ ] 5. Versioning/negotiation: peers/blobs must signal hybrid vs
      classical; staged rollout, no flag day. Old ciphertext stays
      classical (can't retroactively upgrade — note in threat doc).
- [ ] 6. Out of scope phase 1, tracked separately: PQ identity
      *signatures* (non-standardized; revisit only if real-time
      impersonation in a CRQC world becomes in-threat-model).
- [ ] 7. External review of the combiner + Noise integration
      before shipping. This is the high-risk part.

## Honest non-goals / unknowns

- Not started; no code written. Specifics in steps 1–5 are
  provisional pending step 0.
- No claim that the existing zid Noise impl is x25519 *only* until
  the audit confirms the pattern — stated as the likely case, not
  fact.
- Symmetric ciphers are NOT a PQ concern (Grover only halves; 256-
  bit is fine) — do not waste effort "PQ-ifying" AES/ChaCha.

Cross-ref: rotko `quicnet` (X25519MLKEM768 over QUIC/TLS) is the
working precedent for the *confidentiality* half; the
*authenticity* half (falconed) was deliberately deferred there too.
