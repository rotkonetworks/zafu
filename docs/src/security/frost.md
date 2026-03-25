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

DKG is coordinated via a relay server (zidecar). one participant creates a room
and shares the room code with the others. all participants connect to the same
room.

the relay server is used only for message transport. it sees encrypted DKG
messages but does not learn any key material. rooms are ephemeral and
auto-expire after a TTL (default 600 seconds for DKG).

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
threshold and max signers count.

the `MultisigWallet` record stores:

- `keyPackageHex` - hex-encoded FROST key package (secret, encrypted at rest)
- `publicKeyPackageHex` - hex-encoded public key package (shared)
- `ephemeralSeedHex` - seed for signing nonces
- `orchardFvkHex` - 96-byte orchard FVK from the group key
- `address` - the unified receiving address
- `participants` - hex-encoded ed25519 public keys of all participants

## signing coordination

spending from a multisig wallet requires t participants to cooperatively sign.
signing is coordinated through the same relay server.

### signing protocol

**round 1 - commitments**

the coordinator creates a relay room and broadcasts the transaction data with a
`SIGN:<sighash>:<alpha1,alpha2,...>:<summary>` prefix. the sighash is the
transaction's binding signature hash. the alphas are per-action randomizers from
the unsigned transaction.

each participant (including the coordinator) generates fresh nonces for each
action and broadcasts their commitments as a pipe-delimited bundle. nonces are
never reused across different messages.

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

the frost relay client (`FrostRelayClient`) communicates with zidecar via
gRPC-Web over HTTPS. the protocol uses raw protobuf encoding.

relay operations:

- `CreateRoom(threshold, maxSigners, ttlSeconds)` - returns a human-readable
  room code (e.g., "acid-blue-cave")
- `JoinRoom(roomCode, participantId)` - server-streamed; receives join events,
  relayed messages, and room close events
- `SendMessage(roomCode, senderId, payload)` - broadcasts a message to all
  room participants

participant IDs are 32-byte random values generated per session. they are not
linked to persistent identities.

signing rooms use a shorter TTL (default 300 seconds) than DKG rooms.

## trust model

- **no trusted dealer**: DKG generates key shares without any party holding the
  full key. there is no key ceremony where a complete private key exists.
- **relay sees messages but not keys**: the relay server transports DKG and
  signing messages. the cryptographic content is opaque to the relay. a
  compromised relay can deny service or replay messages, but cannot forge
  signatures or learn key material.
- **threshold security**: fewer than t participants cannot produce a valid
  signature. compromising t - 1 participants reveals no useful information
  about the group's private key.
- **ephemeral rooms**: relay rooms expire after their TTL. no persistent state
  is kept on the relay server.
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
- the FROST cryptography runs in a WASM worker. the WASM module is compiled
  from the zcash crate's FROST implementation.
