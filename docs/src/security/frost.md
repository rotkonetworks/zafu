# frost threshold signing

zafu supports t-of-n multisig wallets for zcash using FROST (Flexible
Round-Optimized Schnorr Threshold signatures). a group of n participants
generates a shared key where any t participants can cooperatively sign a
transaction, but fewer than t cannot.

## overview

a FROST multisig wallet in zafu consists of:

- a **threshold** (t) - the minimum number of signers required
- a **max signers** (n) - the total number of participants
- a **key package** per participant (secret - encrypted at rest)
- a **public key package** (shared among all participants, non-sensitive)
- an **orchard full viewing key** derived from the FROST group key
- a **receiving address** derived from the public key package

the public key package and FVK are shared openly. they allow all participants
to derive the wallet's receiving address and decrypt incoming memos. the
private key package is unique to each participant and must be kept secret.

## distributed key generation (DKG)

before a multisig wallet can be used, all n participants must run a distributed
key generation ceremony. DKG produces each participant's key package without
any single party ever holding the full private key.

### coordination

DKG is coordinated over **frostd** - the standard Zcash Foundation FROST relay -
spoken over JSON-HTTP. this replaced an earlier zidecar gRPC room protocol that
carried FROST traffic in the clear. see [relay server](#relay-server) below for
the transport and its trust properties.

frostd fixes a session's participant list at creation and admits nobody else, so
every signer's relay transport public key must be exchanged before the session
exists. a rendezvous discovery room (a human room code) is used to collect those
keys and hand out the session id; the coordinator then creates the frostd
session over the collected keys.

### DKG rounds

the protocol runs in 3 rounds:

**round 1 - commitments**

each participant generates a commitment (broadcast) and a secret (kept
locally). the coordinator's broadcast is prefixed with `DKG:<threshold>:<maxSigners>:`
so joining participants learn the group parameters.

all participants send their commitments through the relay and wait until
`n - 1` peer commitments are collected.

WASM function: `frostDkgPart1InWorker(maxSigners, threshold)`

**round 2 - key shares**

each participant takes their round 1 secret and all peer commitments, then
computes peer-specific key share packages. these packages are broadcast through
the relay. each participant waits for `n - 1` peer packages.

WASM function: `frostDkgPart2InWorker(round1Secret, peerBroadcasts)`

**round 3 - finalize**

each participant takes their round 2 secret, all round 1 broadcasts, and all
round 2 packages, then finalizes the key generation. the output is:

- `key_package` - the participant's secret share (encrypted at rest)
- `public_key_package` - the group's public key (shared)
- `ephemeral_seed` - seed for generating signing nonces

WASM function: `frostDkgPart3InWorker(round2Secret, peerBroadcasts, peerRound2)`

after round 3, the wallet address is derived from the public key package via
`frostDeriveAddressInWorker(publicKeyPackage, diversifierIndex)`.

### storage after DKG

the resulting multisig wallet is stored as a vault entry with
`type: 'frost-multisig'`. the vault's insensitive metadata includes the
threshold and max signers count. the wallet record lives inside the
`zcashWallets` storage key and is therefore sealed by the same AES-256-GCM
scheme described in the [encryption](encryption.md) documentation.

the multisig wallet record stores:

- `keyPackageHex` - hex-encoded FROST key package (secret, encrypted at rest)
- `publicKeyPackageHex` - hex-encoded public key package (shared)
- `ephemeralSeedHex` - seed for signing nonces
- `orchardFvk` / `address` - orchard FVK and unified receiving address derived
  from the group key
- `participants` - public keys of all participants (for display)
- `relayPeerKeys` - the co-signers' frostd relay transport public keys. a
  session cannot be opened without them, because frostd fixes its participant
  list at creation
- `relayCeremonyId` - a pointer to this device's per-group relay identity (see
  [relay server](#relay-server)), so signing reuses the same transport keypair
  that DKG whitelisted

## signing coordination

spending from a multisig wallet requires t participants to cooperatively sign.
signing is coordinated through the same frostd relay. co-signers may be hot
(mnemonic vaults, signing in the extension) or air-gapped (a [zigner](zigner.md)
device co-signs over QR); both speak the same relay wire protocol.

### signing protocol

**round 1 - commitments**

the coordinator creates a relay session and broadcasts the transaction data with
a
`SIGN:<sighash>:<alphas>:<recipient>:<amountZat>:<feeZat>[:<pcztHex>]`
prefix. the sighash is the transaction's binding signature hash; the alphas are
per-action randomizers from the unsigned transaction.

the trailing PCZT is syntactically optional but semantically mandatory. each
co-signer parses it, recomputes the canonical sighash, and OVK-decrypts the
outputs, then refuses to sign if the recipient, amount, or sighash diverge from
the coordinator's claim. this is what binds the human-readable summary to the
transaction being signed - on an unauthenticated relay a summary alone is
attacker-forgeable text. there is no coordinator-claim-only fallback. (the fee
is not independently verifiable this way; the wasm parser does not return the
bundle's value balance.)

each participant (including the coordinator) generates fresh nonces for each
action and broadcasts their commitments as a pipe-delimited bundle
(`C:<commit_a0>|<commit_a1>|...`). nonces are never reused across different
messages.

WASM function: `frostSignRound1InWorker(ephemeralSeed, keyPackage)`

**round 2 - signature shares**

once each participant has collected commitments from all t signers, they compute
a signature share for each action using their key package, nonces, the sighash,
the action's alpha, and all commitments.

shares are sent as `S:<actionIndex>:<shareHex>` messages so the coordinator can
bucket them by action.

WASM function: `frostSpendSignInWorker(keyPackage, nonces, sighash, alpha, allCommitments)`

**aggregation**

the coordinator collects t signature shares per action and aggregates them into
the final authorization signatures. the signed transaction is then broadcast to
the zcash network.

## relay server

the transport is **frostd**, the Zcash Foundation FROST relay, over JSON-HTTP
(routes such as `challenge` / `login`, `create_new_session`, `send`, `receive`,
`close_session`). the default relay is `https://relay.zafu.pro`. an adapter
(`FrostdRelayClient`) keeps the earlier `createRoom` / `joinRoom` / `sendMessage`
call shape, but a "room code" is now a frostd session uuid and message delivery
is poll-based rather than streamed.

### end-to-end encryption

every relayed message is encrypted per-peer with a **Noise_K** session before it
leaves the device (`FrostRelayCipher`, from the wasm bundle). the relay carries
ciphertext only - it never sees key shares, amounts, or recipients. what the
relay does observe is session-membership metadata: the participants' relay
public keys, the session id, and message timing.

### relay identity

each device holds a relay transport keypair that is deliberately **not** a wallet
key. it authenticates to the relay and keys the Noise_K sessions. it is generated
**per multisig group** (stored under `frostRelayIdentities`, keyed by the group's
ceremony id) so that a relay operator cannot correlate one user's separate groups.
losing it costs a session, not funds; leaking it allows relay impersonation only.
this keypair is stored unencrypted in local storage (it is not a spend secret).

per-message `participantId` values are still 32-byte random per session, but the
Noise identity above is the stable, whitelisted transport key.

### rendezvous room code

to restore a human-friendly code without frostd's participant-list rigidity, the
relay also serves a rendezvous discovery room. participants drop their relay
public keys there and the coordinator later announces the frostd session id. the
room is addressed by the SHA-256 of a code shaped as a number plus two bip39
words (e.g. `7-crossover-clockwork`, ~32 bits of entropy); the server sees only
the hash, never the code. knowing the code lets you offer a key, but only the
coordinator's explicit approval puts it into the frostd session, and frostd
admits nobody else. stock frostd relays without these routes fall back to manual
key exchange plus the bare session uuid.

### session lifetime

the client does not rely on any relay-side expiry: the ceremony deadline is
enforced client-side (`FROST_SESSION_TIMEOUT_MS`, 10 minutes for both DKG and
signing).

## trust model

- **no trusted dealer**: DKG generates key shares without any party holding the
  full key. there is no key ceremony where a complete private key exists.
- **relay sees ciphertext, not keys**: DKG and signing messages are Noise_K
  encrypted per-peer before they reach the relay. a compromised relay can deny
  service, drop, or reorder messages and observe session-membership metadata,
  but cannot forge signatures or learn key shares, amounts, or recipients.
- **coordinator cannot redirect funds**: co-signers verify the coordinator's
  PCZT (sighash, recipient, amount) before signing and refuse on any mismatch,
  so a malicious coordinator on an unauthenticated relay cannot get a share for
  a transaction the signer did not see. the fee is the exception - it is not
  independently verifiable from the PCZT (see the signing protocol).
- **threshold security**: fewer than t participants cannot produce a valid
  signature. compromising t - 1 participants reveals no useful information
  about the group's private key.
- **ephemeral sessions**: signing and DKG sessions run for the duration of a
  ceremony (a client-side 10-minute deadline) and are closed afterwards.
- **FROST key packages are encrypted at rest**: each participant's secret key
  package is stored in the extension's encrypted storage, protected by the
  same AES-256-GCM scheme described in the [encryption](encryption.md)
  documentation.
- **re-running DKG**: if a participant loses their key package, the group must
  run DKG again. there is no key recovery mechanism for individual shares.

## limitations

- only zcash orchard is supported for FROST multisig. sapling and sprout are
  not supported.
- all t signers must be online simultaneously during signing coordination.
  there is no asynchronous signing protocol.
- the participant list is fixed at session creation. every signer's relay
  transport key must be exchanged before a session can open; there is no
  discovery of new participants mid-ceremony.
- the FROST cryptography runs in a WASM worker.
