# @zafu/zirc

IRC-style channels on [`@zafu/zid`](https://www.npmjs.com/package/@zafu/zid):
a founder, an operator set, an electorate you can audit, and moderation that
**hides rather than deletes**.

zid is the identity and transport layer (keys, sealed boxes, pairwise encrypted
channels, presence). zirc is what a community builds on top.

```sh
npm install @zafu/zirc
```

## Two entry points

The root is pure: every function is over signed records and **nothing there
talks to a network**, which is what makes the log replayable from genesis
wherever it happens to be stored, and the governance testable without a relay.

The room is the substrate that pure half needs to sit on, and it does talk to
a relay. It is a separate import so the property above survives.

```ts
import { createGenesis, modeStateAt } from '@zafu/zirc'; // pure
import { Room, sealInvite } from '@zafu/zirc/room'; // talks to a relay
```

| module                   | entry             | what it does                                                            |
| ------------------------ | ----------------- | ----------------------------------------------------------------------- |
| `channel-log`            | `@zafu/zirc`      | genesis, the hash-chained log, and **authority verification**           |
| `vote`                   | `@zafu/zirc`      | the electorate at a log index, and whether a decision passed            |
| `room`                   | `@zafu/zirc/room` | the encrypted windowed board, presence, sync, invites                   |
| `commands`               | `@zafu/zirc/room` | `/me`, `/nick`, `/who`, completion - the IRC line parser                |
| _(re-exported from zid)_ | `@zafu/zirc`      | `createGroupSession` - round-structured messages over pairwise channels |

## The room

N members, one shared room secret, and a windowed append-only board the relay
cannot read. It rides the transport a zafu relay already speaks for contact
discovery - `putBucket`/`getBucket` keyed by `(appScope, epoch, shard)` - so a
channel needs no new server behaviour and no relay cooperation. A bouncer in
front changes nothing: it is HTTP, and it is blind by construction because the
relay behind it is.

Per-window AES-256-GCM keys via HKDF, ed25519 per-record signatures,
per-author hash chains, opaque tags, and fixed-size writes - so the relay
cannot tell a one-word reply from a paragraph. `room.ts` states what that
guarantees and, more usefully, what it does not.

The shard in that coordinate comes **from the room secret** by default, so the
channel name is a label and not an address: two rooms sharing a name but not a
secret sit on two different boards, and a board cannot be found by guessing its
name. `public: true` moves the room onto the name's shard instead, so a visitor
holding no key can find it by typing the name - guessable on purpose, and
therefore a choice a room makes rather than a default it falls into. Either way
the relay serving the request sees the shard; pinned `shard` overrides both.

`shardFor: (epoch) => Promise<string>` replaces that one coordinate with one
per window: a two-member pair room passes a shard derived from its secret
and the epoch, so the relay cannot follow the same pair across windows by
shard. It still sees which addresses touched one shard in one window.

A direct message is sealed under a key derived from the room secret **and** the
recipient's pubkey, so it never appears in the public lane and the relay cannot
tell who is talking to whom. That key is not private _between members_: every
member holds the room secret and can derive it, so the DM lane is confidential
against the relay and against non-members only - not against fellow members (or
a past member who kept the secret). That limit, and the shape a larger or social
group needs instead, is spelled out in
[`docs/design/zirc-shared-secret-mailbox.md`](../../docs/design/zirc-shared-secret-mailbox.md).

An invite is deliberately a bearer token, so the dangerous moment is when it
travels. `sealInvite` puts it in a zid sealed box addressed to one recipient -
post-quantum (X-Wing) whenever they advertise a `pq_pubkey` - which means the
transport carrying it does not have to be trusted with the key to a room it
must never read.

### Record size is a `RoomConfig` field, and so is a bigger transport

Chat pads every entry to `ROOM_PLAINTEXT_BYTES` (1 KiB) by default. A room that
carries more than a chat line - a group's seals, signature shares, or a sealed
invite - sets `plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES` (4 KiB) instead.
Every entry in **one** room is still one fixed size, so a window's entries stay
indistinguishable by length within that room; different rooms may choose
different sizes.

```ts
import { GROUP_ROOM_PLAINTEXT_BYTES, Room, relayLimitsFor } from '@zafu/zirc/room';
import { createHttpRelayTransport } from '@zafu/zid';

const plaintextBytes = GROUP_ROOM_PLAINTEXT_BYTES;
const relay = createHttpRelayTransport({ endpoint, ...relayLimitsFor(plaintextBytes) });
const room = new Room(identity, { appScope, roomSecret, relay, plaintextBytes });
```

**This is not optional.** `createHttpRelayTransport`'s own ceiling on one
entry's base64 length (`MAX_RELAY_ENTRY_BASE64`) defaults to 1024 characters -
sized for contact discovery's 64-byte presence blobs. A sealed room record,
even at chat's default 1 KiB plaintext, is already 1053 bytes (1404 base64
characters): bigger than that default. A room built against a transport that
was not sized for it has every one of its entries refused by the transport
before `Room` ever sees them - which is exactly the bug that made every zirc
room unreadable (the entries were there; the client silently would not look at
them). `relayLimitsFor(plaintextBytes)` computes the `maxEntryBase64`,
`maxEntries` and `maxBodyBytes` a room of that size needs - its own read cap,
`ROOM_WINDOW_ENTRIES` (256) entries per window, so a 4 KiB room reads at most
2 MiB per window and never inherits discovery's 16384-entry bucket cap; pass its result into
`createHttpRelayTransport`, and nothing else about contact discovery's own
defaults changes - they are a separate caller with its own options.

The refusal is never silent on the read side either: `Room.sync`/`syncSince`
report it in `RoomSync.dropped` with `kind: 'oversize'` when the transport they
were handed turns out to be too small, so a misconfigured room is a visible
count, not a quiet absence of messages.

### Catching up: `sync`, `syncSince`, and no polling on its own

`Room.sync(historyWindows)` reads the relay's own short retention (12 windows =
5 min each = the discovery default's 1 h). A room kept longer by the relay's
own per-scope retention (see `apps/minirelay`'s `MINIRELAY_SCOPE_RETENTION`)
needs `Room.syncSince(sinceEpoch, maxWindows = 288)` instead: it walks from
`sinceEpoch` (or `maxWindows` back, whichever is closer) to now, so a member
back after a day of being offline pays a bounded number of requests once,
rather than missing everything past the first hour. Persist the epoch you last
synced to (a chat thread's own state, not something `Room` tracks for you) and
pass it back in as `sinceEpoch` next time.

**Nothing here connects by itself.** Constructing or restoring a `Room` - even
with a persisted `head` or a room secret from storage - makes no network
request. Neither does any method except the one a caller explicitly invokes:
`sync`, `syncSince`, `send`, `announce`. There is no constructor-time fetch, no
background timer, and no poll loop inside this package. Wiring "read this room
every N seconds while its thread is open" or "catch it up on an alarm" is the
caller's job, one layer up, gated behind that room's own egress opt-in and
triggered by the user actually opening it - never by extension start, unlock,
or popup open. `room.test.ts` asserts the zero-calls-until-invoked property
directly.

Both `plaintextBytes` and the relay's retention are independent of
`RoomConfig.public`: a public room (zitadel's replacement - named-shard,
unsealed-by-default entries) can set `plaintextBytes: GROUP_ROOM_PLAINTEXT_BYTES`
the same way a sealed group room does, and still wants `relayLimitsFor` sized to
match. Retention is a relay-side policy keyed by `appScope` (see
`apps/minirelay`'s `MINIRELAY_SCOPE_RETENTION`), not by `public`, so a public
room's scope stays on the relay's default (1 h) unless its design asks for
more - a public room's history is cheap to re-derive by asking any member, so
nothing here raises it by default.

## Worked example

```ts
import { ed25519 } from '@noble/curves/ed25519';
import {
  appendRecord,
  createGenesis,
  channelStateAt,
  decisionView,
  verifyChain,
  DEFAULT_RULES,
  type ChannelSigner,
} from '@zafu/zirc';

const signer = (seed: number): ChannelSigner => {
  const key = new Uint8Array(32).fill(seed);
  return {
    pubkey: bytesToHex(ed25519.getPublicKey(key)),
    sign: async bytes => bytesToHex(ed25519.sign(bytes, key)),
  };
};

const founder = signer(1);
const alice = signer(2);

const genesis = await createGenesis({ id: 'chan-1', founder, rules: DEFAULT_RULES });

const records = [];
const add = async (author, body) => {
  const record = await appendRecord({ genesis, records, author, body });
  records.push(record);
};

await add(founder, { kind: 'mode', mode: '+o', subject: alice.pubkey }); // alice may change modes
await add(founder, { kind: 'mode', mode: '+v', subject: alice.pubkey }); // ...and may speak and vote
await add(alice, { kind: 'open', item: 'item-hash', decision: 'hide' });
await add(alice, { kind: 'vote', item: 'item-hash', decision: 'hide' });

await verifyChain({ genesis, records, signer: walletVerifier }); // { ok: true }
channelStateAt(founder.pubkey, records, records.length);
// { ops: [...], voice: [alice] }

decisionView({ genesis, records, item: 'item-hash' });
// { opened: { at, decision: 'hide' }, hide: Tally, reveal: Tally, hidden: true }
```

## The rules that make it work

**Authority is evaluated against the state BEFORE a record, never by its own
effect.** That single ordering rule is what stops self-promotion (`+o`),
self-voicing (`+v`) and self-deoping (`-o`): a record is only valid if its author
was already an operator (for modes) or already voiced (for votes and for opening a
decision). The founder is an operator by construction - the genesis is their
signature - and every other operator exists because an operator granted them.

**The log is hash-chained.** Each record carries the hash of its predecessor, so
it is tamper-evident and totally ordered _without a server_: indices are the
clock, which is exactly what the vote windows assume. Two parties holding the same
records compute the same electorate, the same tallies and the same answer to "is
this hidden".

**Votes are events, not standing influence.** A vote counts for the electorate as
of its own log index: devoicing someone later does not retroactively un-count it,
it only stops them voting again. Rewriting history is what an audit trail exists
to prevent.

**Hiding is a default, never a deletion.** `hide` and `reveal` have separate
thresholds (reveal stricter, so hiding is sticky but reversible), and a later
passed decision supersedes an earlier one. Every tally carries its rejections
**with reasons** ("not voiced when they voted", "already voted", "outside the
window"), so "why is this hidden?" has a mechanical answer - that view is the
moderation of the moderation.

**The electorate is the citizenship list.** `+v` is who may speak in a `+m`
channel and who may vote on moderation; the same privilege, granted the same way,
visible the same way. The cost of a vote is having convinced someone to voice you -
a social cost with a cryptographic record, which is what IRC had and most
vote-based systems lack.

## Custody: the roster is a record, not a setting

A channel that wants k-of-n signing rather than one founder key has to agree on
_which_ keys the k are. That agreement is a `custody` record in the same hash
chain, so there is no second source of truth to reconcile:

```ts
await add(founder, {
  kind: 'custody',
  scheme: 'frost', // a ciphersuite name, not a promise that a client can run it
  threshold: 2,
  epoch: 1, // a roster only ever moves forward
  fingerprint: 'aabbccdd', // the parameters, as the ceremony would print them
  roster: [{ ed25519: alice.pubkey }, { ed25519: bob.pubkey }],
});

custodyStateAt(records, records.length);
// { scheme: 'frost', threshold: 2, epoch: 1, fingerprint: 'aabbccdd',
//   roster: [{ ed25519: alice.pubkey }, { ed25519: bob.pubkey }],
//   at: 2, by: founder.pubkey,   // the record this comes from, and who wrote it
//   history: [{ at: 2, …, added: [alice.pubkey, bob.pubkey], removed: [] }] }
```

Before any custody record the fields but `history` are `null` - "no roster in
force" is a state a view can check, not an exception it has to catch.

**It is a claim about a wallet, never an instruction to a participant.** Nothing
in it can spend and nothing can be spent on it: it says which key material would
have to control an address, and `custodyProblems` checks that the roster is one a
ceremony could actually _run_ - a known scheme, an 8-128 character fingerprint, a
threshold between 1 and the roster size, and for k-of-n with k > 1, distinct
64-character hex ed25519 identities. `verifyChain` refuses a record that fails
that, so a roster no ceremony could run is never replayed as the multisig.

Two rules fall out of the log's own logic:

- **Authority is a vote's authority.** The author must have been voiced _before_
  the record, so a member who cannot vote cannot redefine who the signers are. The
  founder is an operator from the genesis alone but is not voiced _by_ it, so a
  channel whose founder is to write rosters voices them first - the same bootstrap
  the founder needs before their first vote.
- **A roster never rolls back.** `epoch` must strictly advance, so replaying an
  older roster cannot return a multisig to a set that was already superseded.

Because the roster is derivable from the log, `history` answers "did a custodian
leave, and when" mechanically: `added` and `removed` per rotation, compared as
sets, so a repeated name is not a change and a rotation that only reorders the
same roster is not a rotation.

`/frost` is the client-side control plane over those same records:
`/frost show` prints the roster in force, `/frost roster <k>-of-<n> <nick|id>…`
resolves the names - and, for members the room has no name for, their id -
against the members already in the room, `/frost verify <fingerprint>` pins the
roster to the artifact the ceremony printed, and `/frost rotate` plans the next
epoch. The parser refuses a line that looks like key material (`share`, `key`,
`seed`, `secret`, `backup`): a room is the wrong place for a share, because this
log is shared, archived and replayed by everyone in it.

## What it is not

- **Not a transport, at the root.** The governance half is agnostic to where
  the log lives, and that is deliberate. `@zafu/zirc/room` supplies one answer
  (a relay's blind store) without the root depending on it.
- **Not a place content lives.** Items are referenced by hash. The content is
  end-to-end encrypted elsewhere and this layer never sees it, which is why a
  `+G`-style word filter can only ever be a client convention: modes that gate
  _keys_ (`+i`, removal) are enforceable, modes that gate _words_ are conventions
  clients follow, and a client that ignores `+m` is visibly ignoring it because
  every message is signed.
- **Not a relay policy layer.** Relays stay dumb and unmoderated by design; a
  relay cannot moderate what it cannot read. See the `minirelay` reference server
  in the repo for what a relay _can_ express (who may use it, which scopes it
  serves, how fast).

## Limits, stated plainly

- Sessions fan out one copy per member over pairwise channels: right for
  coordination among 2-10 people, wrong for large channels. Beyond that the
  shared-secret mailbox shape is needed, which needs a ratchet and rotation it does
  not have yet (issue #47). What that mailbox is, and exactly what the current
  lanes do and do not guarantee, is written up in
  [`docs/design/zirc-shared-secret-mailbox.md`](../../docs/design/zirc-shared-secret-mailbox.md).
- The founder's key is the channel's root of authority: lose it and the channel
  cannot add operators. A `custody` record can _name_ a k-of-n roster, so the
  multisig's parameters are reproducible from the log, but FROST itself - running
  the ceremony, signing with shares, refreshing them - is not implemented here:
  `/frost rotate` plans an epoch, it does not perform one.
- Rules are fixed at genesis. A community that wants different thresholds forks -
  which is cheap by design, and the reason rules are signed into the channel's
  identity.
- **The room's windows sweep, so a moderation log cannot live in them.**
  `channelStateAt` replays from genesis; a swept log is an operator set you
  cannot recompute. Messages may be ephemeral, the channel log may not. It
  needs durable storage - though not _trusted_ storage, since `verifyChain`
  proves it from genesis, which is what makes an archiving bouncer a cache
  rather than an authority.

## License

MIT
