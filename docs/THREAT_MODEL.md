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
  passphrase-derived key
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
A coordinator that drives a FROST signing session cannot:
- forge signatures (FROST verifies aggregate share consistency)
- replay a participant's nonce commitment across sessions (sessions are
  bound to a session ID and have a fixed end-to-end deadline)
- complete signing without `t` honest participants

A coordinator can still censor a session (refuse to forward messages) or
equivocate (forward different messages to different participants). These
are liveness, not safety, failures.

## Not defended against

### Compromised host browser (standalone mode)
Standalone mode encrypts spending keys at rest, but they are decrypted into
renderer memory at sign time. A compromised browser process - via a
malicious extension, a Chromium 0-day, or a process-injection attack - can
read the keys at that moment. Pair with Zigner if this is in your threat
model.

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
| view-only delegation              | yes (Zigner pairing) |
| forward secrecy on key leak       | no - chain history is permanent |
| metadata vs query backend         | no - run your own |
| host-process compromise (standalone) | no - pair with Zigner |
| host-process compromise (Zigner-paired) | yes for spending; viewing keys still exposed |

## A note on Penumbra voting

The Penumbra protocol re-uses the voting note's nullifier across multiple
votes on the same proposal. This means a single note used to vote multiple
times produces linkable Vote descriptions on chain. Zafu rolls voting notes
over after first use to mitigate cross-proposal linkability, as recommended
by the Penumbra spec.
