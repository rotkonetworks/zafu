# contact cards

## overview

a contact card is a structured zcash memo that shares your name and a
receiving address with another zafu user. the recipient's wallet detects
the card in their inbox and offers to save you as a contact with one tap.

contact cards ride inside zcash shielded notes, so only the sender and
recipient can read them.

## what's in a card

- **name** - your display name (UTF-8, up to 255 bytes)
- **address** - a diversified zcash address unique to this contact
- **zid** - your per-contact identity (optional, 32-byte ed25519 pubkey)

the address is derived per recipient, which enables transport-layer
referral tracking (see [referral display](#referral-display)). the
per-contact zid lets the recipient authenticate messages from you.

## diversified addresses

when you share a contact card, zafu derives a unique zcash receiving
address for that relationship from a stable diversifier index:

```
index   = 1000 + (first 6 bytes of SHA-256(contact_id) as a big-endian u48)
address = address_from_ufvk(ufvk, index)
```

all diversified addresses decrypt to the same wallet during sync; the
diversifier index identifies which contact a payment came through. 48
bits give a birthday-bound collision probability of ~50% at ~16 million
contacts; a collision only makes referral attribution ambiguous for the
two colliding contacts (payments still arrive).

index allocation:

- `0` - default receiving address (your public address)
- `1-999` - reserved for manual address rotation
- `1000+` - per-contact diversified addresses

if the wallet has no zcash unified full viewing key available, the card
falls back to the recipient's own address (no diversification).

## wire format

contact cards use MemoType 0x05 in the zafu memo protocol. the payload
is binary with length-prefixed fields and optional TLV extensions after
the core fields:

```
version(u8=0x01) | flags(u8=0x00) | name_len(u8) | name |
addr_len(u16be) | address | TLV extensions...
```

the only defined extension is tag `0x01` (32-byte ed25519 per-contact
zid). tag `0x02` (post-quantum public key) is reserved and not yet
produced. see the [memo protocol specification](../protocol/memo.md)
section 6 for the full wire format.

## sending a card

1. go to contacts
2. select a contact with a zcash address and choose "share via zcash"
3. zafu derives a per-contact diversified address (recording it in the
   diversified-address store for referral tracing) and a per-contact zid
   (`deriveZidForContact` under the `default` identity)
4. the card is encoded as a memo and prefilled into the zcash send flow

the card is sent as a standard zcash shielded transaction. the memo
carries the encoded card.

> **note:** only the first encoded memo is prefilled into the send flow.
> a card is expected to fit a single 508-byte memo (a typical UA + name
>
> - zid is ~360 bytes). a card large enough to fragment would currently
>   be truncated on send.

## receiving a card

when zafu detects a contact card during zcash sync it surfaces in the
inbox tagged as a contact card. you can:

- view the sender's name and address
- see their per-contact zid, if included
- save them to your contacts (creating the contact and its address) with
  one tap
- see "via alice" if the payment arrived on an address you shared with
  alice (see below)

### referral display

referral attribution is a **transport-layer** signal: when a payment or
card arrives on a per-contact diversified address you previously shared,
the inbox traces the diversifier index back through your
diversified-address records and shows who that address was shared with:

> **conversation #<index>**
> via alice

this works even for plain payments with no memo - the diversified
address itself is the referral signal. there is no identity-layer
("which zid introduced them") referral: sharing a card does not record a
per-contact-zid -> recipient mapping, so referral tracing relies solely
on the diversified address.

## privacy properties

- the card is encrypted inside the zcash shielded note; only the
  recipient can read it
- the receiving address is unique per recipient (transport-layer
  referral tracking)
- diversified addresses are unlinkable on-chain (same FVK, different
  address)
- the diversified-address records (the referral graph) are stored
  encrypted at rest
- no metadata leaks to the network
