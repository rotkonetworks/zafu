# contact cards

## overview

a contact card is a structured zcash memo that shares your name and
address with another zafu user. the recipient's wallet detects the
card and offers to save you as a contact.

contact cards are sent inside zcash shielded notes. only the sender
and recipient can read them.

## what's in a card

- **name** - your display name (UTF-8, up to 255 bytes)
- **address** - your zcash unified address
- **zid** - your per-contact identity (optional, 32-byte ed25519 pubkey)

the zid in the card is unique to the recipient (see [per-contact identity](zid.md#per-contact-identity)).

## wire format

contact cards use MemoType 0x05 in the zafu memo protocol. the payload
is binary with TLV (tag-length-value) extensions after the core fields.

see the [memo protocol specification](../protocol/memo.md) for the full
wire format.

## sending a card

1. go to contacts
2. select a contact with a zcash address
3. tap "share via zcash"
4. the card is encoded as a memo and attached to the send flow

the card is sent as a standard zcash transaction with a dust amount.
the memo carries the encoded contact card.

## receiving a card

when zafu detects a contact card during zcash sync, it appears in
your inbox. you can:

- view the sender's name and address
- see their zid (if included)
- save them to your contacts with one tap

## privacy properties

- the card is encrypted inside the zcash shielded note
- only the recipient can read it
- the sender's zid is unique per recipient (leak detection)
- no metadata leaks to the network
