# Closing the ratchet gap: what to build, in what order

Status: plan. Nothing here is implemented. Follows
`zirc-shared-secret-mailbox.md` (the shape and its limits) and the messaging
review findings (the wallet's channels, the group session, the room). Issue #47
tracks this work.

Scope: the **time-bounded** and **member-bounded** secrecy gaps - the two things
neither the room nor the zid channel has. Post-quantum *confidentiality* is
already in place (X25519 + ML-KEM-768 at every handshake/seal); post-quantum
*authentication* is not, and is stage 5.

## The two gaps, restated precisely

1. **No time bound.** A room key is `HKDF(roomSecret, label(kind), coordinate)`
   with one long-lived `roomSecret`; a channel key is a KDF of the handshake
   chaining key with a forward-only symmetric rekey every 256 messages
   (`noise-channel.ts:619 REKEY_EVERY`). A single state compromise therefore
   opens the whole derivation history that state can compute, and nothing heals
   after a compromise (no PCS).
2. **No member bound.** `RoomIdentity` (`room.ts:175`) carries only
   `pubkey`/`name`/`sign`/`verify`, so the only secret two members share is the
   room secret. The DM lane is therefore sealed under a key every member can
   derive, and removing a member cannot be expressed at the key layer.

## Order, and why this order

Stage 0 is KDF-only and touches no interface. Stage 1 is one interface extension
whose shape already exists in the tree (`SealingIdentity`,
`room/invite-seal.ts:50`). Stages 2-3 fall out of stage 1. Stage 4 is the
expensive one and is the only place a new wire mechanism is needed. Stage 5 is
mostly an honest-gap statement plus identity-layer work.

---

## Stage 0 - per-sender chains and a forward-only epoch key (no interface change)

Two KDF schedule changes, no new keys, no new records:

- **Epoch key advances forward-only.** Keep `roomSecret` as the root, but make it
  a *seed*: `epochSeed_0 = roomSecret`,
  `epochSeed_n = HKDF(epochSeed_{n-1}, 'veil-room-epoch-v1', epochIndex_n)`, and
  derive window keys from `epochSeed_n` instead of the root. Every member
  advances identically from the signed epoch number, so this needs **no
  interaction** - it is the same construction as the channel's existing
  symmetric ratchet, applied to the board.
  Buys: a state capture at epoch N cannot read epochs `< N`. Does not buy: PCS,
  and it does not survive a capture of the *root*.
- **Per-sender chains.** For each author, per epoch:
  `chain_0 = HKDF(epochSeed_n, 'veil-room-chain-v1', author)`,
  `chain_{i+1} = HKDF(chain_i, 'veil-room-chain-v1')`. The record carries its
  chain index inside the sealed plaintext, so the tag stays random-per-write and
  the record format does not change - only the blob version does
  (`BLOB_VERSION 0x01` -> a chained form), which existing readers report as
  unopenable rather than misreading. Readers derive forward from `chain_0` and
  drop chain states once the window falls out of `historyWindows`.
  Buys: per-message forward secrecy within an epoch, per author, with no
  protocol change and no fan-out.

Files: `packages/zirc/src/room/room.ts` (`windowKey`, sealing/opening paths,
blob version table), `room.test.ts`.

Acceptance: a reader given the *epoch N* state cannot open a captured epoch
`N-1` window; two authors' messages with the same index do not share a key; a
reader replaying a pre-ratchet index derives a different key than the sender's
current one; existing sealed records still open (version table).

## Stage 1 - give a member a sealing/DH key (the enabling change)

Extend `RoomIdentity` to include the slice `invite-seal.ts` already defines:

```ts
export interface RoomIdentity extends SealingIdentity {   // sealFor/openSealed
  readonly pubkey: string;                                // ed25519, signing
  readonly kaPubkey?: string;                             // X25519, or a hybrid KEM ek
  ...
}
```

`sealFor`/`openSealed` are already the shape the invite path uses, so the
identity the wallet already has (X-Wing keypair + `keys()`/`sealFor()`) satisfies
it structurally. A member's `kaPubkey` is published as a **room card**: a new
record kind, sealed under a **room-lifetime** key
`HKDF(roomSecret, 'veil-room-card-v1', appScope)`, tag stable per author
(`HKDF(roomSecret, 'veil-room-card-tag-v1', author)`), so the relay merges by tag
and one member cannot overwrite another's card. Room-lifetime rather than
per-epoch because a card must be readable without walking history, and it holds
no secrets - only public keys.

Every pairwise feature below **degrades explicitly, never silently**: a member
with no `kaPubkey` is reported as `unkeyed` in the sync result (the pattern
`unopenable`/`sealed` already uses, `room.ts:269`), and pairwise operations
refuse rather than fall back to a room-secret key.

Files: `packages/zirc/src/room/room.ts` (interface, card kind, sync report),
`packages/zirc/src/room/room.test.ts`, `packages/zid/src/types.ts` (if the KA
suite id belongs in `AdvertisedKeys`), call sites in `packages/zirc/src/index.ts`
and `apps/extension`'s room usage.

Acceptance: a room where one member has no card still syncs; a card written by A
is not replaceable by B; a pairwise operation against an `unkeyed` member throws a
named error rather than sealing under the room secret.

## Stage 2 - rotation on membership change (the thing that makes `-i` real)

With stage 1 in place, the epoch seam becomes a rotation: on join or removal, a
member derives the next `epochSeed`, **seals it to each remaining member's
`kaPubkey`** (`sealFor`), and publishes it under the new epoch's rotate record.
A removed member's card is no longer wrapped, so they cannot read any window
after the rotation - removal becomes a key-layer fact, not a client convention.
Automatic per-epoch advance (stage 0) covers the schedule; this covers the event.

Acceptance: a member holding the full pre-rotation state (root, card, all
chains) cannot open a post-rotation window, even when no other member ever
removed them from a client-side list; a member who joins mid-life can read from
the rotation forward but not backward; a rotation with a member offline still
converges when they next sync.

## Stage 3 - pairwise DM lane (`veil-room-dm-v2`)

Replace the room-secret KDF with the pairwise secret:
`HKDF(ECDH(a.ka, b.ka) [or the hybrid KEM shared secret], 'veil-room-dm-v2', epoch, ...)`,
and derive the DM tag from the same secret so the relay cannot group a pair's
messages either. This makes the honest sentence in `room.ts:47` upgrade from
"NOT secret between members" to "secret between the pair, and from the relay".

Note: the DM *payload* is the same sealed-box format; only the key schedule and
the tag derivation change. Keep v1 readable for captured history (version table),
write v2 only.

Acceptance: a third member holding the room secret, every prior chain and every
epoch seed cannot open a v2 DM; the relay still cannot link a sender to a
recipient; a v1 record from history still opens for its pair.

## Stage 4 - a real ratchet on the channel (the high bar: PCS)

`noise-channel.ts` today ratchets **symmetrically** every 256 messages. Replace
that with a KEM/DH ratchet using the machinery the handshake already has (the
ephemeral X25519 + ML-KEM mix into the chaining key, ~`noise-channel.ts` P2):

- At a ratchet boundary the initiator generates a fresh ephemeral X25519 keypair
  **and a fresh ephemeral ML-KEM-768 keypair**, ships `[e 32][ek 1184]` with the
  next message, and the responder returns the `ct` (1088) - the same
  `noise_init` / `noise_resp` shape the handshake already uses, ~2.3 KB per epoch
  round trip. Reuse the `REKEY_EVERY` schedule rather than running it per message.
- **Do not "optimise" this into a bare ciphertext** by encapsulating to the peer's
  static identity KEM key. That halves the bytes (~1.1 KB) and buys nothing the
  identity does not already hold: the static decapsulation key never dies, so a
  recorded ciphertext plus a later compromise of that key - quantum or not - opens
  every epoch's KEM secret, past and future. PQ FS/PCS needs the epoch's own DK,
  generated fresh and destroyed; that is what the 2.3 KB buys (see the bandwidth
  subsection below).
- Both sides mix the new material into the chaining key exactly as the handshake
  does, so the derivation is already reviewed code.
- The receiver acknowledges the ratchet; until then the sender keeps using the
  current key, so a lost message cannot desynchronise the session.
- **One epoch in flight, and destroy the KEM secret.** Never pre-generate the next
  ratchet's keypair, and drop the decapsulated secret and the ephemeral private
  key once the step is acknowledged. SPQR's own simulations found serial epochs
  mandatory for this reason: a breach that reaches a pre-generated DK loses every
  future epoch, not one.

Buys: post-compromise security against a classical attacker, and - under the
hygiene rule above - post-quantum post-compromise security **and** per-ratchet
post-quantum forward secrecy: the SPQR-shaped property, reached with our existing
KEM mix rather than by vendoring Signal's spec (see the Triple Ratchet section).

Wire: new ephemeral material per ratchet. Gate it behind a **new protocol name
string** (the suite string is already part of the handshake), so 0.1.0 peers keep
the current lane and the version negotiation is explicit - this is also where the
"no responder emits the refusal frame" gap gets closed for real, since here both
ends are ours and the new suite is a genuine capability.

Files: `packages/zid/src/noise-channel.ts` (the ratchet), `types.ts` (suite id),
`channel-select.ts` (a fourth mode, or extend `'hybrid'`),
`noise-channel.test.ts` (a captured-state-after-ratchet test is the whole point
of the stage).

Acceptance: an attacker holding the state at message N cannot decrypt message
`N + interval`; a dropped ratchet message does not strand the session; a late or
duplicated ack does not fork the key schedule; the pre-step KEM secret and
ephemeral private key are gone after the ack; a 0.1.0 peer still completes on the
old suite.

### Bandwidth: the cost against the SPQR / Braid / Katana numbers

The bar, in bytes on the wire per epoch (one object from each side), with our
`REKEY_EVERY = 256` interval:

| scheme | CKA material per epoch | amortised @256 | burst shape |
| --- | --- | --- | --- |
| Double Ratchet (classical DH only) | 32 (one X25519 pubkey) | 0.13 B/msg | one 32 B pubkey |
| ML-KEM-768 generic CKA = **SPQR / Braid** | 1184 (`ek`) + 1088 (`ct`) = 2272 | 8.9 B/msg | 1184 / 1088, chunked into 32-512 B pieces |
| Katana (Opp-RKEM-CKA, USENIX'25 §4) | 1344 (`ek`) + **72** (`ct`) = 1416 | 5.5 B/msg | `ek` chunked, `ct` = one chunk |
| Apple PQ3 | 2272 every ~50 msgs, re-sent until acked | 45+ B/msg | 2.3 KB, repeated |
| **stage 4 (ours)** | 32 + 1184 + 1088 = **2304** round trip | **9.0 B/msg** | init 1216 / resp 1088 |

Numbers: ML-KEM-768 from the Braid spec (`HEADER 64`, `EK 1184`, `CT1 960 +
CT2 128 = 1088`, `MAC 32` on each); Katana's `(|ek|,|ct|) = (1344B, 72B)` and
chunk counts from `usenixsecurity25-auerbach.pdf` §4. All of it is per *epoch*,
not per message.

- **We are inside the budget by ~4x.** Signal's own published target is to keep
  post-quantum PCS overhead at ~40 B per message (USENIX'25 §4); at 256 messages
  per epoch that is a ~10 KB epoch budget and stage 4 spends 2.3 KB (22%), or
  9 B/message. This is why the interval, not the scheme, is the knob.
- **No chunking or erasure coding is needed.** Braid chunk-splits because Signal
  piggybacks ratchet material inside message capacity and must never emit a
  2 KB-size tell; our channel already carries a 1281-byte `noise_init` frame
  (`NOISE_INIT_MIN_LEN`), so a 1.2 KB ratchet frame is not a new size class and
  there is no message-capacity budget to fit into. Chunking only becomes
  mandatory if the interval drops to tens of messages.
- Katana is the size win worth watching - a 72 B `ct` against 1088 B, 1416 B
  against 2272 B per epoch - but it is a research ratcheting KEM, not standard
  and not deployed; ML-KEM-768 is what Signal and we both ship.
- The comparison is also the argument against the bare-ciphertext shortcut: the
  cheap row does not exist for a *PQ* ratchet. Any scheme that delivers the
  property pays for both a fresh encapsulation key and its ciphertext.

## Stage 5 - post-quantum authentication (state the gap, then close it at the identity layer)

Signatures are classical (ed25519, secp256k1) everywhere. Per-record signatures
should stay ed25519 - a hybrid ML-DSA signature is ~3.3 KB, which on a board with
256-entry windows and fixed-size records is a different product. What is worth
doing: **hybrid signing at the identity/card layer** - a room card (and the zid
identity bundle) carries `ed25519 + ML-DSA-65` so a member's key material cannot
be forged by a quantum attacker even though individual records are still ed25519.
Until that lands, the honest sentence everywhere is "confidentiality is hybrid,
authentication is classical".

The threshold half of that gap is a separate project, not a change in this
repo: a post-quantum replacement for FROST is threshold *signing* at the crate
layer, and that design lives with the crate -
[frostito `docs/pq-threshold.md`](https://github.com/penumbrafi/frostito/blob/main/docs/pq-threshold.md).
What it means for zafu:

- the multisig **spending** path stays classical until Zcash accepts a
  post-quantum authorization signature. Orchard verifies RedPallas; no DKG in
  our wasm changes that.
- the **zirc operator quorum** and channel authentication are ours to move,
  because the verifier is ours.
- any threshold signature on the board carries the same byte budget that rules
  out per-record ML-DSA: a relay record is capped at 1 MiB, and the dispatch
  window is fixed-size.

---

## What not to do

- **Do not implement Signal's SPQR / Triple Ratchet verbatim.** It is well
  analysed - Eurocrypt'25 and USENIX'25 papers, ProVerif models, Rust extracted
  to F* on every CI run - and it is still the wrong fit: SPQR is a per-message
  header protocol for 1:1 sessions that carries chunked ML-KEM material through
  message capacity. Our ratchet is a session rekey, our rooms broadcast, and our
  records have fixed-size dispatch windows. Stage 4 reaches the same property with
  a KEM mix already in our handshake; what is worth copying from Signal is policy,
  not wire - see the Triple Ratchet section below.
- **Do not adopt MLS/TreeKEM yet.** It is the standards-track answer for
  social-scale groups, but it is a large dependency and a new wire. Revisit after
  stage 2 proves the message-based membership model; if the roster grows past a
  few tens of members, MLS becomes the right call.
- **Do not run ML-KEM per message.** ~2.3 KB per epoch round trip against
  256-entry dispatch windows and a 1 MiB read ceiling is not a trade at 256
  messages per epoch; stage 4's interval is the knob, not the scheme.
- **Do not move to ML-KEM-1024** in cards/handshakes without a reason: cat. 3
  hybrid with X25519 already exceeds the bar the threat model sets, at ~1.5 KB
  less per member per key.
- **Do not fall back to a weaker key** anywhere a pairwise or rotated key is
  missing. Report `unkeyed`; refuse the operation.

---

## Alternative considered: zero-overhead VSS ("zoda") as the room key schedule

Raised as: run the whole room together by expanding a zero-overhead verifiable
secret sharing over the channel, in place of pairwise wraps and per-author
chains.

What the tree already has, so nobody re-derives it:

- `zt_encode_frames` / `zt_encode_frames_auto` (`@repo/zcash-wasm`, the "zoda
  transport"): systematic `(k, n)` **erasure coding** of CBOR into `zt:type/hex`
  frames sized for a scannable QR - `k` = the frames needed to reconstruct,
  parity sized by `redundancy_pct`. **Dispersal only as shipped**: any `k` frames
  reconstruct the payload in full, so a codeword is not a sharing and must not
  carry a secret. A *hiding* variant - the same code with the message masked so
  fewer than `t` chunks reveal nothing, plus commitments so a chunk is verifiable
  - is a genuine verifiable secret sharing at the same code rate, and is the
  variant discussed below.
- `packages/encryption`: box, key derivation, key at rest. **No secret sharing**,
  so there is no group key schedule in it to reuse.
- FROST (`packages/zid/src/group.ts`, `docs/src/security/frost.md`): a 3-round
  DKG over `frostDkgPart1/2/3` in wasm, secp256k1, per-participant `key_package`
  secret share. This is the wallet's threshold-signing path.

The question is narrower than "coding vs. sharing". **A broadcast room has no
threshold worth protecting**: every member legitimately holds the epoch key, so
hiding it from any member is not a goal and sharing it out t-of-n buys nothing for
the message key. Where a hiding, verifiable sharing is decisive is anywhere the
threshold is a *feature* - authority, quorum-read, dispersal of content that is
not key material. What it cannot do is create the member bound:

- **A sharing scheme cannot evict anyone.** The bound comes only from a
  per-member distribution that excludes the departed member's keys. Shares
  published under the previous epoch key are readable by the departed member, who
  collects `t` chunks and reconstructs; shares published in the clear are worse.
  Membership change costs one per-member keying whichever scheme computes the
  shares - VSS changes *who can compute and verify* them, not whether they are
  keyed to members.
- **`t = n` degenerates to rotation.** If every member must decrypt every message
  - which is what a broadcast room means - then the epoch key has to be known to
  all, and re-sharing *is* stage 2. Rotation with a commitment needs no sharing
  scheme at all: a dealer picks the epoch secret, publishes a commitment, and
  seals one share per member to their `kaPubkey`.
- **`t = n` with public shares is a no-op**, and `t < n` is a different product,
  not a drop-in: nobody can read alone, and `t` members must cooperate per window
  (a release record on the board, plus liveness). Right for a moderator-quorum or
  escrow room, wrong for open chat. That is where a real verifiable sharing earns
  its place.

What the "run the whole room together" idea does earn, and is worth taking:

- **At scale, replace the mesh with a dealer plus a commitment.** Past a handful
  of members, wrapping the new epoch to each member by hand is O(n) records and an
  O(n) key inventory. One dealer, one broadcastable commitment, `n`
  verifiably-correct sealed shares is the same record cost with one round and no
  per-peer key bookkeeping. The dealer and the epoch's roster are decided by the
  **zirc authority log** (`packages/zirc/src/channel-log.ts` and
  `packages/zirc/src/vote.ts`: the electorate at a log index, verifiable by anyone
  holding the records) - implemented and tested, not yet wired to a room -
  so "who may deal epoch `n`, to whom" is a signed fact, not a convention.
- **Use it where it actually fits: the board, not the key.** `k`-of-`n` coded
  frames of each window, published to several relays, so no single hostile relay
  can withhold history - and with the *hiding* variant no sealing pass is needed
  to put a window on the board, because `t-1` chunks reveal nothing. Dispersal-only
  frames cannot do that (a relay holding `k` frames reads the window), which is
  exactly why the hiding property is worth having even though it does nothing for
  the message key. Availability is a different axis from the member bound and
  composes with every stage here.
- **Do not let a sharing scheme become a second trust model.** The zirc log owns
  membership; any rotation, dealer election, or re-share has to be a function of
  it. Two places that decide "who is in this epoch" will disagree the first time
  membership races.

### Where the hiding variant wins, concretely

Ranked by value to this repo, assuming it delivers hiding below `t`, verifiable
chunks, and no overhead beyond the code's own rate:

1. **Board availability with no sealing pass.** Dispersing a window as `t`-of-`n`
   hiding chunks to several relays is safe *in the clear*; a hostile relay holding
   `t-1` learns nothing and cannot withhold the window. This is the one property
   the shipped dispersal-only frames lack and the reason to build the variant at
   all. Design note: the commitment has to ride the chunk it verifies (or the
   board's record header) so a chunk is checkable without a second fetch.
2. **Dealerless epoch key generation, one round, verifiable.** Today's stage 2
   has a dealer pick the epoch secret; a sharing round replaces "trust the
   dealer's randomness" with "verify the commitment", and consolidates the
   per-member distribution into one broadcastable codeword instead of `n` wraps.
   For a broadcast room this buys assurance, not secrecy - every member learns the
   epoch key anyway - so it is an improvement to the mechanism, not to the model.
3. **Threshold where the threshold is the point.** `k`-of-`n` operator authority
   (the zirc/`FROST` layer) and any future quorum-read room. Before considering it
   as a replacement for the 3-round `frostDkgPart1/2/3` wasm DKG, check that the
   shares are compatible with FROST signing over secp256k1 - one round instead of
   three is worth a real comparison, but the wallet's DKG must not be swapped
   without that review.
4. **Backup/airgap split.** A seed or PCZT split across QR pages where any single
   page is useless and any `t` reconstruct - a product win the dispersal-only
   frames cannot deliver, at the same frame budget.

### zoda-VSS vs. FROST: different primitives, one shared idea

FROST's DKG *is* a VSS - rounds 1-3 are commitments, shares, finalize over a
Shamir (Reed-Solomon) sharing in the secp256k1 scalar field. The two part company
on payload domain and on what the shares are for:

| | zoda-VSS (hiding variant) | FROST as shipped |
|---|---|---|
| shared object | arbitrary bytes: epoch key, window, PCZT, seed | a secret **scalar** in secp256k1, whose group element is the wallet key |
| needs | a linear code + commitments; field arithmetic and hashes | linearity over the scalar field, a curve, hash-to-curve, scalar mults |
| reconstruction | terminal - `t` chunks put the secret in the clear | **never** - the scalar does not exist on any device; shares are used in-process to sign |
| rounds | 1 broadcast to distribute (dealer from the log), 1 round to reconstruct | 3 DKG rounds, 2 signing rounds, all `t` online, 10-minute client-side deadline (`FROST_SESSION_TIMEOUT_MS`) |
| verifiability yields | "this chunk is a correct share" | "these shares define the same group key and mine can sign" - verifying shares plus the FVK |
| output | possession: the bytes | authority: a valid Orchard authorization signature |
| transport | records on the async room board | frostd JSON-HTTP session with a fixed participant list |

So they are not interchangeable, and the split is clean: **use FROST where the
secret must never exist** (multisig spending; the k-of-n operator authority the
zirc log needs), **use the VSS where the bytes are supposed to come back** (board
dispersal, epoch-key rotation, QR backup splits).

The one place they could meet is replacing FROST's 3-round DKG with a one-round
VSS. The precondition is not hiding but **homomorphism**: FROST computes the
group public key and each verifying share from the DKG commitments, so a
hash-verified chunk commitment is not enough - the commitment must be additive
(Feldman/Pedersen) and the code must be linear over the scalar field, with the
output shaped like `frostDkgPart3InWorker`'s (`key_package`,
`public_key_package`, `ephemeral_seed`). Until that is shown, the variant is a
dispersal/shared-secret primitive, not a DKG for a Schnorr group.

Could the variant supply a post-quantum threshold signature? It can supply the
*distribution* half: a threshold signature needs no trusted dealer, verifiable
shares, hiding below `t`, and **linearity over the algebra the signing protocol
works in**. The first three are generic and post-quantum safe when the code's
operations are information-theoretic; the fourth has to be checked per scheme, and
that is where the scheme-specific work starts - lattice keys survive the check
(`t = A*s1 + s2` interpolates through a linear code over `Z_q`), FROST's
Schnorr *signing* does not (Dilithium rejection sampling is nonlinear in the
share). Written up in `~/rotko/frostito/docs/pq-threshold.md`, which is also
where the `ThresholdScheme` seam lives; it is a frostito design, not a room-key
one.

Outside our control either way: an Orchard spend authorizes with RedPallas, so a
post-quantum *spending* threshold needs a Zcash network upgrade, not just a new
DKG. Where a PQ threshold is actionable in this repo today is the authority that
never touches the chain - the zirc operator quorum signing log records, relay
and message authentication. That is stage 5's lane, not the room key
schedule's.

Non-goal: the room's message key, for the reasons above. It is inert there, not
unsafe.

## Alternative considered: Signal's Triple Ratchet

Signal's shipped design runs the Double Ratchet (ECDH DH ratchet plus symmetric
chain) and the Sparse Post-Quantum Ratchet (SPQR) side by side and KDFs the two
message keys together, so an attacker must break both X25519 and ML-KEM-768.
Read on its own, SPQR is a continuous key agreement over ML-KEM-768 that builds a
*standalone* messaging protocol with PQ forward secrecy and PQ post-compromise
security. Its sparse part is a state machine plus erasure-coded chunking ("ML-KEM
Braid"): an EK is 1184 bytes and a CT 1088, split so the bulk of both travels in
parallel - only EK1 (2 chunks) and CT2 (4 chunks) have to arrive without data
going back. Epochs advance in *series*: their simulations
found that generating EK#2 before CT#1 lands loses the property, because a device
breach would then expose DK#1..DK#n and with them every future epoch's secrecy.

Where our plan already agrees:

- **Hybrid by construction.** Both designs mix, never replace: ours folds the
  ML-KEM secret into the chaining key, theirs KDFs two independent keys.
- **Sparse by some mechanism.** They buy sparsity with chunking research; we buy
  it with an interval, because on our wire a ratchet step is a session rekey, not
  a header field.
- **Standard KEM only.** They built Katana, a KEM designed for ratcheting, and
  then chose ML-KEM-768 to stay on standards. Same call here.
- **Explicit downgrade discipline.** SPQR data is MAC'd so a middleman cannot
  strip it, downgrade is allowed only on the first exchange, and a future release
  stops offering sessions without it. Our suite string sits inside the handshake,
  so capability negotiation is authenticated *by construction* - but the missing
  refusal frame is exactly the silent-fallback hole they engineered against.

Where it differs, and why we are not porting it:

1. **No per-message envelope.** SPQR advances an epoch from data in every message
   header. Our frames are fixed-shape on a Noise transport: no spare field, and a
   1.1 KB KEM ciphertext per message against a 256-entry dispatch window is not a
   trade (stage 4's bandwidth subsection is the arithmetic). So we do not get
   per-message PQ forward secrecy - we get it at the ratchet interval, and the
   plan should say exactly that.
2. **Broadcast rooms are not sessions.** The Triple Ratchet is pairwise; group
   messaging fans out pairwise sessions. Our board is one ciphertext read by every
   member, membership from the zirc log, rotation as the ratchet. The pairwise
   analogy covers the `noise-channel` lane only; the room's epoch and rotation
   work has no counterpart there.
3. **Serial composition, not parallel.** Signal can analyse two ratchets plus a
   combiner. Ours is one key schedule, so "either layer alone protects" is not a
   claim we may make without a statement about the mix: the mix must be
   domain-separated (`HKDF` over chaining key and KEM secret with a fixed `info`),
   and the argument owed is a hybrid-composition one, not two independent ones.
4. **Verification budget.** They model in ProVerif from the start, extract Rust to
   F* with hax on every CI run, and prove invariants and panic-freedom. We have
   tests and a suite gate. The affordable substitute is a modelled ratchet state
   machine tested across every transition - lost ratchet message, lost ack, late
   ack - since stage 4's "a dropped ratchet message does not strand the session"
   is the poor man's version of exactly that proof.

What to copy - policy, not wire:

- **One epoch in flight.** Never pre-generate the next ML-KEM keypair; destroy the
  DK after the step. This is SPQR's own simulation finding, and it is the
  difference between PQ post-compromise security and PQ forward secrecy alone.
- **Lock in, then enforce.** Once a session has ratcheted on the new suite, do not
  fall back - and plan the release that stops offering the legacy lane.
- **A middleman must not be able to steer the ratchet** by dropping the larger
  message. Ours is simpler than theirs: a step is a handshake exchange with an
  ack, and a dropped step is retried, never skipped.

The sentence stage 4 earns: "hybrid confidentiality; PQ forward secrecy at the
ratchet interval; PQ post-compromise security under one-epoch-in-flight and DK
destruction; authentication classical until stage 5." Not "SPQR-compatible", and
not per-message PQ forward secrecy.

## Fork policy - the log is a fact, not a verdict

The channel log records **validity**, not **canonicity**. A record is signed and its
authority is a function of the state *before* it, so no branch can be forged or
self-authorized (`channel-log.ts`: a record "is authorized by the state BEFORE it,
never by its own effect"). Nothing in the log says which of two valid branches is
*the* one - and the dispersal construction cannot say it either: sampling proves
"the data behind commitment `C` is available and unique", which only moves the
question to *which `C`*.

Decision: **do not auto-resolve.** Keep the fork visible and let the people in the
room settle it, the way a hard fork or a netsplit is settled - by who stays. No new
trusted party, no consensus rule, no leader.

What "visible" costs, or the fork is invisible and there is nothing to choose:

- **Detection is not free.** A withheld bucket is currently indistinguishable from a
  quiet one: `verifyChains` skips a gap - "a gap, not a break" - and the relay decides
  which records come back at all. Visible forks need **witnesses**: each record commits
  the digest of the bucket state its author saw. Then any member's record proves a
  write existed, and a drop is *provable* rather than inferred. One field, on the
  per-author chain that already exists.
- **A fork is attributable, which is why "show both" is fair here.** Both branches are
  valid and both are signed, so a client can name the signer of each head. Unlike a
  coin fork, the divergence is a *person* - visible, nameable, and accountable.
- **A fork is not a merge.** A netsplit heals because each half is only *missing* the
  other's events; two operators appending `at = prev + 1` never union. So the read path
  stops at the fork point, shows both heads, and takes a **local pin**. The pin is a
  preference, never a network rule - convergence is social or it does not happen.
- **Moderation forks with it.** A moderator granted on one branch is not a moderator on
  the other, and a rule-driven auto-hide differs by branch with neither being wrong.
  That is the intended signal: a fork means a human, not a resolver.

The one constraint the no-rule path still inherits from the log: a branch may only read
the state *before* it. A pin reads the present; a resolution rule that read the branch's
own effect would re-open self-authorization through the side door.

## The decisions this plan defers

1. **Stage 4 timing.** Stages 0-3 are cheap, unlock the member bound and the
   removal semantics, and leave the room strictly better. Stage 4 is where the
   real work and the wire change live. Recommendation: land 0-3 first (small,
   testable, no interop risk), then 4 as its own change with the new suite string.
2. **Message-based vs. MLS.** Recommendation: stay message-based through stage 3,
   and take the MLS decision only when a room's roster size (not its optimism)
   forces it.
3. **Quorum-read rooms.** Whether any room should ever need `t` members online to
   open a window (moderator quorum, escrow). Recommendation: no - keep every room
   all-members-read and put the threshold in the authority layer (FROST), where it
   already lives.
