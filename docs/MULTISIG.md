# Multisig

Zafu supports `t-of-n` shielded multisig vaults on Penumbra and Zcash.
Implemented end-to-end as of `v24.0.0-beta.1`.

## Per-chain by construction

Vaults are per-chain. The two networks use different curves and different
FROST instantiations, and a key share for one chain cannot sign for the
other:

- Zcash Orchard: FROST(Pallas)
- Penumbra: FROST(decaf377)

Pallas is the curve used in Halo 2's pasta cycle, so Orchard's spend
authority sits naturally on it. decaf377 is the prime-order group used for
Penumbra signatures, defined over the BLS12-377 scalar field. The two have
no compatibility.

A single Zafu vault therefore corresponds to one chain. A user who wants a
multisig presence on both runs two ceremonies and ends up with two vaults.

## DKG

The DKG protocol is the three-round Pedersen-based ceremony from the FROST
appendix - in `frost-core` it is `keys::dkg::part1`, `part2`, and `part3` -
not the FROST signing protocol itself (RFC 9591). Strictly: FROST specifies
threshold signing; DKG is a separate scheme bundled by convention with
FROST implementations.

The three rounds run over the same QR transport used for single-signature
flows with Zigner. A single end-to-end deadline (10 minutes) covers the
entire ceremony; if any participant misses it, the session is abandoned and
must be restarted.

### Zcash UFVK derivation

For a Zcash vault, every participant must deterministically arrive at the
same Unified Full Viewing Key. The UFVK is derived from:

1. the FROST aggregate verification key (the multisig spend public key),
   identical to all participants by construction
2. a 32-byte random `sk` sampled by the host (room creator) and broadcast
   in the round-1 message; this seed is used to derive `nk` and `rivk`

Given identical inputs, every participant computes the same UFVK. The
UFVK contains an Orchard receiver and a transparent receiver. The Orchard
receiver's spend authority is `t-of-n` FROST. The transparent receiver in
the UFVK is **not** multisig-controlled at the chain level; it exists to
populate the UFVK structure but spending from it requires the holder of
the corresponding transparent secret. For multisig-controlled spending,
use only the Orchard receiver of the shared address.

## Signing

FROST signing is two rounds:

1. each signer samples a per-signature nonce commitment and broadcasts it
2. the coordinator gathers `t` commitments, fixes the message hash, and
   each signer produces a partial signature share which the coordinator
   aggregates into the final signature

In Zafu, both rounds run over QR with a session ID binding all messages to
a single ceremony. Nonce commitments are sampled per session and not
reused across sessions. The session ID and the sighash are both signed
into each participant's contribution; a coordinator cannot replay a
commitment from one session into another (which is the classic FROST
footgun, RFC 9591 §6.1).

## Failure modes

- **a participant goes offline mid-ceremony** - the session times out and
  must be restarted from round 1. No partial state carries over.
- **the coordinator equivocates** (sends different messages to different
  participants) - participants will fail to reach a consistent shared
  state and signing aborts. Equivocation cannot produce a forged
  signature.
- **the coordinator censors** - liveness failure. The coordinator can
  refuse to drive the session forward but cannot complete it without the
  participants.
- **fewer than `t` participants are online at signing time** - signing
  fails. The vault remains intact; another attempt with `t` available
  signers will succeed.

## Limits

- one ceremony per vault at a time
- 10-minute end-to-end deadline per session
- no recovery if a participant loses their key share short of running a
  new DKG with the remaining `n - 1` and a new joiner. (Forward-recovery
  is a planned feature.)
