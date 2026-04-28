# Threat model

## What Zafu is and is not

Zafu is a client wallet. The chain-level privacy guarantees of Penumbra and
Zcash are properties of those chains, not of Zafu. Zafu's job is to be a
privacy-respecting client - one that does not degrade those guarantees
through its own design choices, and one that gives the user honest tools
to manage their own operational privacy.

This document states what Zafu defends against and, equally importantly,
what it does not.

## Custody modes

Zafu has two custody modes. They differ in where spending keys live and
therefore in their threat model.

### Paired with Zigner (recommended)

- spending keys live on a dedicated offline phone running
  [Zigner](https://github.com/rotkonetworks/zigner)
- Zafu holds only viewing keys (Penumbra `FullViewingKey`, Zcash UFVK with
  Orchard + transparent receivers)
- the channel between Zafu and Zigner is QR codes only - no Bluetooth, USB,
  or wifi
- the user must visually verify destination addresses on Zigner before
  signing

### Standalone

- spending keys live on the host browser, encrypted at rest with a
  passphrase-derived key. Concretely: PBKDF2-HMAC-SHA-512 with 210,000
  iterations and a per-wallet random salt, deriving an AES-256-GCM key
  with a 96-bit random nonce. See
  `packages/encryption/src/key-stretching.ts`.
- decrypted into renderer memory at sign time
- intended for users who explicitly accept host-process compromise as part
  of their threat model

## Defended against

### Passive network observers
All on-wire formats - PCZT for Zcash, Penumbra `TransactionPlan` and
`AuthorizationData`, FROST DKG and signing messages - are designed for a
public broadcaster. An observer of the wire learns no more than what the
chain protocol already reveals.

### Compromised Zigner
If the air-gapped phone is lost or compromised, the spending keys are gone,
but Zafu's viewing keys remain on the host. Historical transaction privacy
is intact: the attacker who has the spending key can spend remaining funds
but cannot retroactively unmask shielded history any more than the
chain-level cryptography already permits.

### Malicious multisig coordinator
A FROST aggregator cannot produce a valid signature with fewer than `t`
valid shares. A coordinator that drives a signing session therefore cannot:
- forge signatures (a valid signature requires `t` real shares from real
  signers; the coordinator holds none on its own behalf)
- replay a participant's nonce commitment across sessions (sessions are
  bound to a session ID and have a fixed end-to-end deadline)
- complete signing without `t` honest participants

A coordinator who is itself one of the `t` signers contributes one share
like any other. They do not gain extra signing power from being the
coordinator.

A coordinator can still censor a session (refuse to forward messages) or
equivocate (forward different messages to different participants). These
are liveness, not safety, failures.

### Address reuse on Zcash
The Zcash receive screen automatically bumps both the shielded diversifier
index and the transparent index every time it is opened. Both indices are
persisted in `chrome.storage.local`, so a user who opens Receive once a
day gets a fresh address per day with no manual action. Manual rotation
is also exposed as a button. See
`apps/extension/src/routes/popup/receive/index.tsx:489`.

## Not defended against

### Compromised host browser (standalone mode)
Standalone mode encrypts spending keys at rest, but they are decrypted into
renderer memory at sign time. A compromised browser process - via a
malicious extension, a Chromium 0-day, or a process-injection attack - can
read the keys at that moment. Pair with Zigner if this is in your threat
model.

### Active network adversary with compromised TLS trust
TLS to the query backends (Zidecar, pd, RPC nodes) is sufficient against
passive observers and untrusted networks. It is *not* sufficient against
an attacker who can issue or substitute trusted root certificates - for
example, a corporate transparent proxy with a CA in the user's OS trust
store, or a state-level CA-issuance attack. Such an attacker can both
read and modify queries.

Cryptographic proof verification (Zidecar header proofs, Penumbra block
processor) protects against the *modify* side - fabricated chain state
will not validate. It does not protect against the *read* side - the
attacker still learns query metadata. Users in this threat environment
should self-host both Zidecar and pd and reach them through a VPN or Tor.

### Viewing key compromise
For privacy wallets the viewing key is as sensitive as the spending key,
in a different way. A leaked spending key lets an attacker spend
remaining funds. A leaked **viewing key** (Zcash UFVK or Penumbra
`FullViewingKey`) lets an attacker decrypt every shielded note ever sent
to that user, past and future, for as long as the chain history is
reachable. Pairing with Zigner protects spending keys but viewing keys
remain on the host. A compromised host browser - even one that cannot
sign new transactions - can therefore retroactively unmask the user's
shielded history. Users who consider their full transaction graph
sensitive should treat viewing keys as secrets, not as "watch-only"
credentials.

### Network metadata leaks
For Zcash, Zafu queries a [Zidecar](https://github.com/rotkonetworks/zidecar)
gRPC endpoint for note commitment trail, header proofs, commitment proofs,
and nullifier proofs. For Penumbra, it queries a pd / RPC endpoint for chain
state. Each query reveals to the server the timing and shape of what the
user is interested in - which commitments, nullifiers, addresses, and
proposals.

Zafu does not currently proxy these queries over Tor or any other anonymity
network. If metadata privacy against the query backend is in your threat
model, run your own Zidecar and pd.

### Address-substitution before the QR is displayed
Zigner displays the destination address; the user is expected to verify it
matches what they intended to send to. Zafu cannot detect a host-side
malware swap of the recipient address before the QR is generated. The Zigner
display is the last trustworthy reference.

### Compromised Zigner phone
"Air-gapped phone in airplane mode" is operational user discipline, not
something Zafu or Zigner can enforce. Airplane mode disables radios, not
USB, accelerometer, microphone, or camera side channels. A truly hostile
environment requires more than an off switch.

### Rollback or equivocation by the chain query backend
Zafu verifies cryptographic proofs against returned state. A malicious or
broken backend can refuse to serve recent blocks, serve stale state, or
selectively withhold information. Run your own backend if liveness against
this attacker is required.

### Side-channel observation of the host
Compiler-side, OS-side, hypervisor-side, and physical-side channels (timing,
EM, acoustic, screen-reflection) are out of scope. Zafu makes no
constant-time guarantees beyond what its underlying crypto libraries
provide.

## Privacy properties summary

| property                          | preserved |
|-----------------------------------|-----------|
| sender / receiver / amount        | yes (chain-level) |
| cross-tx linkability              | yes (chain-level, modulo voting linkability per Penumbra spec) |
| address reuse on Zcash            | yes - auto-rotated on every Receive screen open |
| view-only delegation              | yes (Zigner pairing) |
| forward secrecy on spending-key leak | no - chain history is permanent |
| forward secrecy on viewing-key leak  | no - all shielded receipts past and future become readable |
| metadata vs query backend         | no - run your own |
| TLS trust against active adversary | partial - proofs catch tampering, queries still leak |
| host-process compromise (standalone) | no - pair with Zigner |
| host-process compromise (Zigner-paired) | spending: yes, viewing: no (see "Viewing key compromise" above) |

## A note on Penumbra voting

The Penumbra protocol re-uses the voting note's nullifier across multiple
votes on the same proposal. This means a single note used to vote multiple
times produces linkable Vote descriptions on chain, and a subsequent spend
of that note is linkable to the prior votes.

The mitigation, recommended by the Penumbra spec, is to *roll the note
over*: when casting a vote, bundle a `Spend` and `Output` of the same note
into the same transaction so the value moves to a fresh note. Future votes
and spends use the fresh note, isolating the original nullifier.

The Penumbra planner (upstream `penumbra-web/packages/wasm/crate/src/planner.rs`,
~line 720) constructs vote transactions this way: for each staked
delegation note used to vote, it emits a paired vote plan and spend plan
that rolls the value over. Zafu uses this planner unmodified, so vote
transactions built by Zafu inherit the rollover behavior.
