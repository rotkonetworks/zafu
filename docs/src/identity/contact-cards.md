# contact cards

## overview

a contact card is how two zafu users find each other. it carries an
address made for one person and the keys of that one relationship, so the
other side can save you, write to you and later know a card really comes
from you.

there is one card per relationship. a card you give alice is unrelated to
the card you give bob: different keys, different address.

## the card (v2)

a v2 card is signed. every field is covered by the relationship's
**inception key**, an ed25519 key made for this one relationship, so
nothing can be swapped in transit and a later update provably comes from
the same person.

it carries:

- the inception key (32 bytes) and a pair key-agreement key (X25519, 32
  bytes) that opens the pair room you two share
- a zcash orchard receiver made for this one person, and a penumbra
  address while penumbra is on
- the relay to meet on (`relay.zafu.pro` unless you chose another)
- capability bits (chat, mailbox, calls, deals, discovery, ...), so the
  other side only offers what you turned on
- an optional name, at most 32 bytes; a card has no name unless you add
  one
- a revision and a creation time, so a newer card replaces an older one

the same bytes travel three ways:

- a **QR code** to scan in person
- a **link**, `zafu.pro/c#...`, to send any way you like
- a **shielded memo** (MemoType 0x05, version byte 2), inside a zcash
  payment

a card is about 185 bytes (265 with penumbra), so it fits one memo.

### answering, updating, closing

a card has a kind: `card`, `answer`, `update` or `close`.

1. you show a card. its answer room is derived from the card alone, so
   whoever holds the card can find it.
2. the other person saves you and posts their own card as an `answer`,
   sealed to your pair key so only you can read it.
3. you choose which answer to accept; only then is your pair room made
   from both pair keys.
4. a later `update` (higher revision) travels in the pair room; a card you
   cancel gets a signed `close`.

an unanswered card stops being watched after a while; a card that was only
shown on screen stops after a day.

## the memo card from a saved contact

sharing your card with a contact you already saved, "share via zcash"
puts an older memo card (version byte 1) into a zcash payment. it carries
your address for them and, as tagged extensions, the relationship's
inception key, its pair key and, when it answers their card, their key.
it is not signed, so zafu treats what it says as the sender's word until
you meet; a v2 card is preferred wherever both are possible. zafu still
reads version 1 cards it receives.

## addresses made for one person

the address on a card is a diversified zcash address made for that one
contact. all of them belong to the same wallet; the diversifier index
tells zafu which contact a payment came through.

```
index   = 1000 + (first 6 bytes of SHA-256(contact_id) as a big-endian u48)
address = address_from_ufvk(ufvk, index)
```

the address function takes a 32-bit index, so only the low 32 bits of
that number are used: two contacts share an address with even odds around
65 thousand contacts. a shared address only makes the "who was this from"
signal ambiguous for those two; payments still arrive.

your own receive address is different: each time it is shown or copied
zafu picks a fresh random index, so there is no fixed public address to
link payments by.

if the wallet has no zcash viewing key available, no per-contact address
is made and the card is not sent.

## receiving a card

a card arrives in the inbox (or opens from a link or a scan). zafu checks
the signature of a v2 card before showing anything. you can see the name
(if any), save the person with one tap, and, for a payment that arrived
on an address you made for someone, see who it came through:

> conversation #&lt;index&gt;
> via alice

this works for plain payments too: the address itself is the signal.

## privacy properties

- a card in a memo is inside the shielded note; only the recipient reads
  it. a card link or QR is readable by whoever holds it, which is why an
  answer is sealed to your pair key
- every relationship has its own keys and address, so two people cannot
  link their cards to the same person by comparing them
- the per-contact address records are stored encrypted at rest
- the relay sees that a room is used, not what the card says
