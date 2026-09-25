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

| module                   | entry               | what it does                                                            |
| ------------------------ | ------------------- | ----------------------------------------------------------------------- |
| `channel-log`            | `@zafu/zirc`        | genesis, the hash-chained log, and **authority verification**           |
| `vote`                   | `@zafu/zirc`        | the electorate at a log index, and whether a decision passed            |
| `room`                   | `@zafu/zirc/room`   | the encrypted windowed board, presence, sync, invites                   |
| `commands`               | `@zafu/zirc/room`   | `/me`, `/nick`, `/who`, completion - the IRC line parser                |
| _(re-exported from zid)_ | `@zafu/zirc`        | `createGroupSession` - round-structured messages over pairwise channels |

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

An invite is deliberately a bearer token, so the dangerous moment is when it
travels. `sealInvite` puts it in a zid sealed box addressed to one recipient -
post-quantum (X-Wing) whenever they advertise a `pq_pubkey` - which means the
transport carrying it does not have to be trusted with the key to a room it
must never read.

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
  not have yet (issue #47).
- The founder's key is the channel's root of authority: lose it and the channel
  cannot add operators. k-of-n operator keys (FROST) is the answer, and it is not
  implemented here.
- Rules are fixed at genesis. A community that wants different thresholds forks -
  which is cheap by design, and the reason rules are signed into the channel's
  identity.
- **The room's windows sweep, so a moderation log cannot live in them.**
  `channelStateAt` replays from genesis; a swept log is an operator set you
  cannot recompute. Messages may be ephemeral, the channel log may not. It
  needs durable storage - though not *trusted* storage, since `verifyChain`
  proves it from genesis, which is what makes an archiving bouncer a cache
  rather than an authority.

## License

MIT
