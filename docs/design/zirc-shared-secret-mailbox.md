# The shared-secret mailbox: what zirc rooms are, and what a social group needs

Status: design note. The current lanes are implemented; the ratchet and
rotation are not.
Scope: `packages/zirc/src/room/room.ts` (the room), `packages/zirc/src/group.ts`
re-exported through `@zafu/zirc`, `packages/zirc/src/room/invite-seal.ts`.
Referenced by `packages/zid/src/group.ts` and `packages/zirc/README.md`.

## Why this note exists

`packages/zid/src/group.ts` (the FROST ceremony session) says it is not a chat
protocol and points here for "the shared-secret mailbox shape a larger or social
group would need". The zirc room _is_ that mailbox's first cut, so this note
records its exact shape, its exact guarantees, and the two things a real
social-scale mailbox still needs - a ratchet and rotation - which the room does
not have.

## The mailbox shape

A room is N members, one shared 32-byte **room secret**, and a windowed,
append-only board that a relay cannot read:

    coordinate   (appScope, epoch, shard) - the shard from the room secret
                 (sealed, the default) or from the channel name (`public: true`)
    entry        { tag, blob } - merged by tag, read by fetching the window
    epoch        one presence epoch (5 minutes); windows sweep

Everything is derived from the one secret, so joining means being handed the
secret (an invite is a bearer token) and there is no per-member state on the
relay:

- **keys** - `HKDF-SHA256` per `(appScope, shard, epoch, kind)`. Compromising
  one window's key does not open another's, and messages and presence never share
  a key.
- **tags** - opaque, merged by the relay. A message tag is random per write, so
  one member cannot compute a peer's tag and overwrite their entry. A presence
  tag is stable per `(member, window)`, so refreshing presence replaces one's own
  entry instead of piling up.
- **write size** - every record is padded to one fixed size, so the relay cannot
  tell a one-character reply from a paragraph.
- **authorship** - every record is signed by its author's ed25519 key, and each
  author's records form a hash chain (`prev`). The chain is tamper-evident; the
  relay stores a set, so there is no global order.
- **address** - the shard is `roomShardFromSecret(appScope, secret)`: a function
  of the secret, so a name is a label and not an address, and one name means one
  room _per secret_. Nobody can enumerate boards by guessing names. `public:
true` derives it from the channel name instead, which is what lets a reader
  with no key find the room at all - and what makes it enumerable. Either way the
  relay serving the request is addressed by the shard and sees it; what sealing
  the coordinate buys is unguessability, not blindness.

## What the current lanes do and do not guarantee

### Sealed room messages, actions, presence

- **Do**: only holders of the room secret read anything; the AEAD's AAD binds the
  window (version, appScope, shard, epoch, kind), so a record cannot be replayed
  into a different window or relabelled as another kind; a signature binds the
  author, the sequence number, and the window.
- **Do not**: provide forward secrecy past the window. The room secret is
  long-lived and the derivation is a KDF, not a ratchet - a member who leaks the
  secret reads this window and every window its writers derive from it.

### The direct-message lane

A DM is sealed under `HKDF(roomSecret, 'veil-room-dm-v1', appScope, shard,
epoch, recipientPubkey)`. The recipient's client finds it by trying that key on
entries the room key did not open; the sender never appears in the clear, so the
relay does not learn who is talking to whom.

- **Do**: keep the relay blind to who is talking to whom, and keep non-members
  out. Any member can seal _to_ any other with no key exchange.
- **Do not**: keep a DM secret **between members**. Every input to the KDF
  except the room secret is public, and the secret is shared with all members, so
  any current member - and any past member who kept a copy - can derive the key
  and read every DM in the room. The lane is confidential against non-members,
  not against fellow members.

A genuine member-to-member secret would need a **pairwise key exchange** between
the two identity keys (ECDH over their long-term keys), so the room secret no
longer contributes to the DM KDF. That is a deliberate change, not yet made: the
current `RoomIdentity` slice carries only `sign`/`verify`, so it has no DH to
derive a pairwise secret from, and adding one is an API change to every caller.
Until then the claim above is the honest one, and `room.ts` states it in the
same words.

### The plain (unsealed) lane

A visitor with no invite publishes unsealed. The relay, the operator, and any
other reader can read these records.

- **Do**: keep the lane honest - every plain record is still signed by its
  author, and the window it was written in is signed into the record bytes
  (version `0x03`), so a relay cannot serve a past window's plain line, or
  presence, as current.
- **Do not**: keep anything private. Plain means plain.

## Why a larger or social group needs a ratchet and rotation

The shared-secret mailbox is right for a small, closed, relatively stable set of
people - a room of peers who all trust each other with one key. It breaks down
on two axes:

1. **Scale / fan-out.** The ceremony session in `packages/zid/src/group.ts`
   sends one copy per member over pairwise channels; cost grows with the roster,
   so ~8-10 members is where another shape is needed. A mailbox already avoids
   the fan-out for the _board_, but a member-to-member-secret DM lane would need
   a pairwise channel per pair, which is the same fan-out problem.
2. **Membership change and compromise.** One shared secret cannot express "this
   member left" or "this window's key leaked". Rotating the room secret is the
   only remedy today, and it is a deliberate act (a new room, or a re-invite) -
   not automatic, and it does not remove the past member's ability to read
   anything they already derived.

A social-scale mailbox therefore needs two things this does not have:

- **A ratchet.** A per-sender key schedule that advances with every message
  (symmetric, or a sender-keys / MLS-style tree), so a key compromise does not
  expose past or future messages. This is what buys forward secrecy and
  post-compromise healing. The current per-window HKDF is a _derivation_, not a
  ratchet: there is nothing to heal with.
- **Rotation.** Epoch keys that are rotated automatically on a schedule and,
  critically, on every membership change, so a departing member cannot read
  future windows and their retained state cannot decrypt new traffic. Rotation
  and the ratchet together are what make `-i` / removal enforceable at the key
  layer rather than a client convention.

The standard shapes for this are the IETF MLS group key schedule (TreeKEM) and
per-sender chains; either way the KDF inputs must stop being "one long-lived
shared secret", which is also exactly what would let the DM lane become a real
member-to-member (or pairwise ratcheted) secret.

## Non-goals of this note

- Not a change to the relay protocol. The relay stays dumb; a ratcheted mailbox
  still rides `putBucket`/`getBucket`, or a new one - that is a separate
  decision.
- Not the FROST ceremony session itself (`packages/zid/src/group.ts`), which
  deliberately stays a minutes-long fan-out and not a chat protocol.
- Not an implementation plan with dates; issue #47 tracks the work.

## Implementation status

Implemented today, in `packages/zirc/src/room/room.ts`:

- per-window HKDF keys and AAD-bound sealed records;
- the epoch signed into plain records (version `0x03`), so a past-epoch plain
  record is refused rather than served as current;
- per-author hash chains with a persisted head (`RoomConfig.head`), so a relay
  cannot roll an author's chain back and make them re-sign a used `(seq, prev)`.

Not implemented:

- any ratchet or automatic rotation (this note);
- member-to-member DM secrecy (needs the pairwise ECDH above);
- k-of-n authority (FROST) for operator keys, tracked separately.
