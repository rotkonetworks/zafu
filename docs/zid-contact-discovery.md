# ZID Private Contact Discovery

Design note for the ZID contact-discovery layer: how two friends learn each
other is present, over a relay that is operated by rotko itself, without
handing that relay the social graph.

Status at time of writing: the cryptographic foundation is committed
(`feat/zid-contact-discovery`, one commit `b9c1d57f`). Storage, relay, and
presence-blob layers are reserved branch names with no code yet. See section 8.

Code anchors:

- `apps/extension/src/state/identity.ts` - contact key-agreement
  (`deriveZidContactCardKey`, `zidContactRootSecret`, `ContactSuite`,
  `ContactCardKey`, the suite-blind boundary comment, the PQ-recovery block).
- `packages/zid/src/contact-discovery.ts` - the tag layer (`presenceEpoch`,
  `jamTimeslot`, `rendezvousTag`, JAM-time constants).
- `packages/zid/src/channel.ts`, `noise-channel.ts`, `sealed-remark.ts`,
  `contacts.ts`, `provider.ts` - the existing crypto and API surface reused.

---

## 1. Problem and threat model

We want private presence discovery: two people who have already added each
other as contacts should each be able to learn "my friend is online right now
in app X" with zero interactive handshake, by reading and writing a shared
BLIND key-value relay.

Blind means the relay stores opaque `(tag -> blob)` entries. It routes and
serves bytes; it is not trusted with meaning.

The adversary is concretely:

- The relay operator, which is rotko itself. This is the sharpest part of the
  model: we do not get to assume an honest-but-curious third party we do not
  control. The operator sees every read, every write, every source address,
  and every timestamp.
- Other users of the same relay.
- Post-hoc database readers: anyone who later obtains a snapshot of the relay
  store (subpoena, breach, backup).

What must stay hidden from all of the above:

- The social graph. Who is a contact of whom. No party should be able to
  cluster tags into "these belong to one friendship" or "these N tags all
  belong to Alice's friends".
- Cross-epoch-linkable identity. A tag seen in epoch E must not be linkable to
  the same relationship's tag in epoch E+1, so an observer cannot follow one
  edge over time.
- Friend counts. The number of contacts a given user has, and the fan-out of
  any user's presence writes.

What we explicitly do NOT try to hide at this layer: that SOMEONE is using the
relay from a given network location at a given time. Network-level anonymity
(who is connecting) is a separate concern handled by transport (the poker relay
already acts as an IP-privacy shield; the same pattern applies here).

---

## 2. The construction

### One long-term contact key-agreement key per identity

Each named ZID identity derives exactly one contact key-agreement (KA) key,
under the hash-based derivation tree, tag `contact-ka-v1`:

```
deriveSeedForContactKa(identity) = deriveSeed(identity, "contact-ka-v1")
```

(`apps/extension/src/state/identity.ts`, `deriveSeedForContactKa`.) The public
half is X25519 and is published in the identity's contact card via
`deriveZidContactCardKey`, which returns a `ContactCardKey { suite, publicKey }`
with `suite = 'x25519-v1'` today. The private half never leaves the extension
and is zeroized immediately after use.

The tag `contact-ka-v1` is deliberately suite-independent: the same hash-derived
seed feeds whichever KA suite the card declares. A distinct future tag
`contact-ka-xwing-v1` is reserved only if a hybrid ever needs its own seed.

### Pairwise root secret, established ONCE and cached

When two friends have each other's contact card, each can compute the same
pairwise root secret with zero communication, via static-static X25519 DH:

```
zidContactRootSecret(mnemonic, identity, peerCard)
  = X25519(my_contact_ka_priv, peer.publicKey)   // raw 32-byte shared secret
```

(`apps/extension/src/state/identity.ts`, `zidContactRootSecret`.) Note this
returns the RAW shared secret. There is no HKDF at establishment; the HKDF lives
one layer up, in the tag derivation. The cached root is opaque bytes.

This establishment is the ONLY suite-specific step. The code comment above the
block is explicit and load-bearing:

> Callers MUST establish the root secret once (at contact-add) and cache it -
> do NOT re-derive per tag, or the KEM suite can't slot in (a KEM is not a
> NIKE).

X25519 is a NIKE (non-interactive key agreement): both sides derive the same
secret from static keys, no ciphertext on the wire. That is what allows the
symmetric, communication-free establishment. Caching the result is what keeps
the door open for a KEM (section 5), which is not a NIKE.

### Per-epoch rendezvous tag

From the cached root secret, both parties derive the same per-epoch tag under
which presence is published (`packages/zid/src/contact-discovery.ts`,
`rendezvousTag`):

```
rendezvousTag(rootSecret, appOrigin, epoch, publisherPubHex)
  = HKDF-SHA256(
        ikm  = rootSecret,
        salt = <none>,
        info = "zid-rvz-v1"
             || SHA256(appOrigin)          // fixed 32 bytes
             || u32be(epoch)               // fixed 4 bytes
             || SHA256(publisherPubHex),   // fixed 32 bytes, suite-agnostic
        len  = RENDEZVOUS_TAG_BYTES (16)
    )
```

Two properties are engineered into `info`:

- Unambiguous domain separation. Every field is hashed or encoded to a FIXED
  length before concatenation, so no field can be confused for another
  regardless of input length or KA suite. Hashing `publisherPubHex` in
  particular means a hybrid suite's longer public key still occupies exactly 32
  bytes here.
- Direction by publisher pubkey. The direction of a tag is encoded by WHOSE
  contact-card pubkey goes into the tag (the publisher's), not by any ordering
  convention. To ANNOUNCE yourself you publish under the tag computed with your
  own pubkey; to FIND a friend you compute the tag with the friend's pubkey.
  Two independent one-way tags per relationship, no "who is party A" tie-break.

### Presence blob AEAD

The value stored under a tag is an AEAD-sealed presence blob. The epoch is
placed in the AEAD associated data (AAD), binding a blob to the epoch it was
published for and rejecting any blob replayed into a different epoch. This blob
format is DESIGN, not yet code (section 8); the reused AEAD pattern is the
`hkdf -> AES-256-GCM` seal already used in `sealed-remark.ts` and the
ChaChaPoly transport in `noise-channel.ts`.

### Forward secrecy: NONE by default (decision A, accepted)

Epoch-in-the-KDF gives cross-epoch UNLINKABILITY, but NOT forward secrecy, and
there is no cheap ratchet that would add it here. The pairwise root secret is a
STATIC NIKE output (X25519 DH of the two long-term contact-KA keys), so it is
deterministically recomputable from those keys. A future compromise of the
contact-KA key (or the mnemonic), combined with logged relay transcripts,
therefore recovers every past epoch's tags and presence blobs - a hash-ratchet
does NOT prevent this, because the attacker just re-derives the static base and
ratchets forward. (An earlier draft shipped a `ratchetRootSecret`; it was
removed because it implied a forward secrecy it cannot provide in this model.)

Accepted posture (decision A): no forward secrecy. Presence is low-sensitivity
metadata (who is online in an app, and an ephemeral session pubkey in the
blob), not funds. This is a deliberate scope, stated plainly.

Bounded mitigation (fast-follow, decision C): PERIODIC CONTACT-KA KEY ROTATION
with old-key deletion - the same rotation-index mechanism the per-site ZID keys
already use. Deriving each epoch from the CURRENT contact-KA key and deleting
the previous private key caps a compromise's reach to the window since the last
rotation (e.g. monthly), without any interactive Double-Ratchet machinery or
breaking the non-interactive "compute the tag offline" property. True
per-message forward secrecy would require an ephemeral, interactive handshake
(Signal-style) and is out of scope for a presence beacon.

---

## 3. JAM-time epoch

The epoch clock is JAM time: a fixed-genesis wall-clock slot counter, NOT chain
height. Constants (`packages/zid/src/contact-discovery.ts`, inlined from the
`jamtime` package, rotkonetworks/jamtime v1.1.0, to avoid a runtime dependency):

```
JAM_COMMON_ERA     = 1735732800   // 2025-01-01 12:00:00 UTC, unix seconds
JAM_SLOT_DURATION  = 6            // seconds per JAM timeslot
PRESENCE_EPOCH_SLOTS = 50         // the single tunable K

jamTimeslot(t)  = floor((t - JAM_COMMON_ERA) / JAM_SLOT_DURATION)
presenceEpoch(t) = floor(jamTimeslot(t) / PRESENCE_EPOCH_SLOTS)
```

So one presence epoch is `50 * 6s = 300s = 5 minutes`. `PRESENCE_EPOCH_SLOTS`
is the one knob: shorter means fresher presence, more relay churn, and a
shorter cross-epoch linkage window; longer means the opposite.

Why wall-clock JAM slots beat the alternatives:

- Versus arbitrary periods (for example "round `Date.now()` to 5 minutes"):
  JAM time is a single canonical, published origin and cadence. Both parties
  compute the same epoch number from their own clock with no negotiation and no
  shared configuration to drift.
- Versus chain height or a Zcash/Penumbra epoch: chain height is not a fixed
  cadence (block times vary, chains halt, reorgs happen), and it forces every
  participant to be syncing that specific chain just to compute a tag. ZID is a
  cross-network identity that must work for a user who is not syncing any
  particular chain. JAM time needs nothing but the wall clock.

Clock skew is handled by a plus-or-minus one epoch window: a reader checks the
current epoch and its immediate neighbours so that two clocks a few minutes
apart still rendezvous across an epoch boundary. This skew window is DESIGN for
the reader/storage layer; there is no skew constant in `contact-discovery.ts`
today (section 8).

---

## 4. The mandatory traffic-analysis mitigation

State this plainly, because it is the part that is easy to get wrong and it
inverts the security claim if omitted:

Epoch rotation hides tag VALUES. It does NOT hide traffic PATTERNS.

A naive implementation where each client does one `GET tag` per friend and one
`PUT tag` per announce hands the relay operator - which is rotko - exactly the
metadata we promised to hide:

- Friend counts. A client that issues N reads per epoch reveals it has roughly
  N contacts.
- Timing-correlated edges. If Alice PUTs tag T and, moments later, Bob GETs tag
  T from a different address every epoch, the operator can correlate the two
  endpoints of that edge by timing and co-occurrence, reconstructing the social
  graph tag-value-blindness was supposed to protect.

Rotating the tag value every 5 minutes does nothing against this: the operator
does not need the value, only the access pattern.

Mandatory mitigation, one of:

1. Broadcast-bucket reads plus padded fixed-cadence writes.
   - Reads: the relay streams the epoch's FULL tag set (or a coarse bucket of
     it) to every client; each client matches its friends' tags LOCALLY. The
     relay never sees which specific tags a given client cares about, so it
     cannot count that client's friends.
   - Writes: presence PUTs go out in fixed-cadence, padded batches (a constant
     number of entries per epoch regardless of how many are real), so write
     volume and timing do not leak fan-out or reveal which write pairs with
     which read.
2. Alternatively, an HONESTLY-SCOPED adversary model. If the deployment
   genuinely trusts the operator not to do traffic analysis, that assumption
   must be written down as such, not smuggled in.

Without one of these two, the claim "the relay learns nothing" is FALSE against
the operator. Do not soften this: tag-value privacy and traffic-pattern privacy
are separate properties and only the first comes free from epoch rotation.

The broadcast-bucket approach is what bounds scaling (section 7).

---

## 5. Post-quantum agility

The card is suite-versioned: `ContactCardKey` carries a `ContactSuite` id
(`'x25519-v1'` today; `'xwing-v1'` reserved). Because everything downstream of
the pairwise root secret consumes it as opaque bytes and is SUITE-BLIND, a
hybrid slots in at establishment ONLY:

- `'x25519-v1'` (today): a NIKE. Static-static X25519 DH, no wire ciphertext.
- `'xwing-v1'` (reserved): X-Wing (X25519 + ML-KEM-768) hybrid, a KEM.
  Encapsulate/decapsulate is asymmetric and DOES carry a ciphertext, so the
  secret is established once at contact-add and cached. The cached root is still
  suite-agnostic bytes; the tags, epochs, and presence blob never change.

This is exactly why the establish-once-cache rule exists. A KEM is not a NIKE:
you cannot re-run encapsulation per tag and get a stable shared secret. Caching
the root at contact-add is what lets a KEM suite replace X25519 without touching
any downstream layer. The suite check lives only in `deriveZidContactCardKey`
and `zidContactRootSecret`; both throw on an unknown suite today.

This mirrors the FALCON-512 migration already reserved in `identity.ts` (the
POST-QUANTUM RECOVERY block, tags `zid-falcon-v1` / `zid-falcon-cross-v1`): the
entire hash-based derivation tree is already quantum-safe, and only the final
curve operation is swappable from the same mnemonic with no protocol break. The
contact-KA agility is the encryption-side analogue of that signing-side plan.

---

## 6. The general-primitive / apps-specialize boundary

The extension exposes GENERAL verbs. Apps compose them. No app-specific code
lives in the extension.

The verbs already present in `packages/zid/src/provider.ts` set the pattern:

- `zafu_sign` (delegation) - one consent grants a session key.
- `zafu_pick_contacts` - scoped contact discovery; returns app-scoped opaque
  handles, never raw pubkeys (`contacts.ts` `computeHandle`:
  `SHA256("<pubkey>:<appOrigin>:zid:contact:v1")`, deterministic per
  contact+app, unlinkable across apps).
- `zafu_send_invite` / `zafu_incoming_invite` - seal-and-deliver over the
  handle, extension resolves handle to pubkey internally.

Contact discovery adds general verbs in the same shape: derive-contact-card-key,
establish-root-secret, compute-rendezvous-tag-for-app-origin, seal/open a
presence blob. Apps such as poker or zeratul COMPOSE these - poker publishes
presence at its own `appOrigin`, zeratul at its own, and the `appOrigin` binding
inside the rendezvous tag keeps the two apps' tags unlinkable even for the same
friendship. There is no poker-specific or zeratul-specific branch in the
extension.

The consent model is one consent, operate-within: the user approves the
relationship (or the app session) ONCE, and the extension then operates within
that grant without interrupting the user for every epoch's read/write. Few
extension interruptions is a deliberate UX property, not an accident.

---

## 7. Scaling ceiling

The broadcast-bucket read (section 4) is what protects friend counts, and it is
also the scaling bound. Streaming the epoch's full pairwise-tag set to every
client is linear in the total number of published tags. That holds comfortably
to roughly 10^4 to 10^5 users. Beyond that, per-client download of the global
bucket per epoch stops being practical.

The named path beyond that ceiling is FMD-style detection keys (fuzzy message
detection): a per-user detection key lets the relay do probabilistic
server-side filtering, so a client downloads a tunable false-positive fraction
of traffic instead of the whole bucket, trading a precise, quantifiable amount
of metadata leakage for sublinear bandwidth. Penumbra already ships this
mechanism (its `fmd` detection-key construction), so it is a known, implemented
design rather than research. It is external to this repo.

Do NOT build FMD now. The broadcast bucket is correct and simple for the target
user count; FMD is the documented escape hatch for when the user count demands
it.

---

## 8. Status

Implemented (committed on `feat/zid-contact-discovery`, commit `b9c1d57f`):

- Contact key-agreement in `apps/extension/src/state/identity.ts`:
  `deriveSeedForContactKa`, `x25519KeypairFromSeed`, `ContactSuite`,
  `CONTACT_SUITE_DEFAULT`, `ContactCardKey`, `deriveZidContactCardKey`,
  `zidContactRootSecret`, plus the suite-blind boundary comment and the
  reserved `contact-ka-xwing-v1` / PQ notes. Covered by
  `identity.test.ts` additions.
- The rendezvous-tag layer in `packages/zid/src/contact-discovery.ts`:
  `jamTimeslot`, `presenceEpoch`, `rendezvousTag`, the JAM-time constants, and
  `RENDEZVOUS_TAG_BYTES`. Exported from
  `packages/zid/src/index.ts`. Covered by `contact-discovery.test.ts`.
- Reused crypto it builds on: `sealed-remark.ts` (ephemeral-DH + HKDF +
  AES-256-GCM seal), `noise-channel.ts` (Noise IK, ChaChaPoly transport),
  `channel.ts` (authenticated X25519 e2ee), `contacts.ts` (app-scoped handles).

In flight / reserved (sibling branches `feat/zid-contact-discovery-storage`,
`feat/zid-contact-relay`, `feat/zid-presence-blob`). At time of writing these
are branch names pointing at the SAME foundation commit with no additional code
yet.

NOT yet implemented (DESIGN in this note only):

- The presence-blob AEAD format with epoch in the AAD.
- The plus-or-minus one epoch skew window (no skew constant in code today).
- Root-secret caching / contact-add storage (the "establish once and cache"
  callers).
- The relay protocol itself, and critically the section 4 traffic-analysis
  mitigation (broadcast-bucket reads + padded fixed-cadence writes). Until that
  ships, an operator-run relay CAN recover friend counts and timing-correlated
  edges. This is a hard prerequisite for the privacy claim, not a nice-to-have.
- FMD detection keys (section 7) - explicitly deferred.
