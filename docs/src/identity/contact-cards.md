# contact cards

## overview

a contact card is a structured zcash memo that shares your name and
receiving address with another zafu user. the recipient's wallet
detects the card and offers to save you as a contact.

contact cards are sent inside zcash shielded notes. only the sender
and recipient can read them.

## what's in a card

- **name** - your display name (UTF-8, up to 255 bytes)
- **address** - a diversified zcash address unique to this contact
- **zid** - your per-contact identity (optional, 32-byte ed25519 pubkey)

both the address and zid are unique per recipient. this enables
referral tracking at two layers:

- **transport layer**: the diversified address tells you which
  contact's address was used for a payment, even without a memo
- **identity layer**: the zid tells you which contact introduced
  the sender, even if the sender uses a different address

## diversified addresses

when you share a contact card, zafu derives a unique zcash address
for that relationship:

```
index = 1000 + (SHA-256(contact_id) mod 2^31)
address = get_address_at(index)
```

all diversified addresses decrypt to the same wallet during sync.
the diversifier index identifies which contact the payment came
through.

index allocation:
- `0` - default receiving address (your public address)
- `1-999` - reserved for manual address rotation
- `1000+` - per-contact diversified addresses

when a payment arrives on a per-contact address, zafu checks the
diversified address records to show "via alice" - regardless of
whether the sender included any memo.

## wire format

contact cards use MemoType 0x05 in the zafu memo protocol. the payload
is binary with TLV (tag-length-value) extensions after the core fields.

see the [memo protocol specification](../protocol/memo.md) for the full
wire format.

## sending a card

1. go to contacts
2. select a contact with a zcash address
3. tap "share via zcash"
4. zafu derives a diversified address and per-contact zid
5. the card is encoded as a memo and attached to the send flow

the card is sent as a standard zcash transaction with a dust amount.
the memo carries the encoded contact card.

zafu records both the diversified address and zid in the encrypted
share log and diversified address records. this enables referral
tracing at both the transport and identity layers.

## receiving a card

when zafu detects a contact card during zcash sync, it appears in
your inbox. you can:

- view the sender's name and address
- see their zid (if included)
- see who introduced them ("via alice") if:
  - the zid matches a previously shared per-contact identity, or
  - the payment arrived on a per-contact diversified address
- save them to your contacts with one tap

### referral display

if someone sends you a payment or contact card through an address
you shared with alice, zafu shows the introduction:

> **bob** wants to connect
> via alice - shared 2026-03-15

this works even for plain payments with no memo - the diversified
address itself is the referral signal.

## privacy properties

- the card is encrypted inside the zcash shielded note
- only the recipient can read it
- the address is unique per recipient (transport-layer referral tracking)
- the zid is unique per recipient (identity-layer referral tracking)
- the share log and address records are encrypted at rest
- diversified addresses are unlinkable on-chain (same FVK, different address)
- no metadata leaks to the network
