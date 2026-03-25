# zid - zafu identity

## what is a zid

a zid is a cross-network ed25519 identity derived from your wallet
seed phrase. it is not tied to any specific blockchain - it is the
cryptographic identity of the person behind the wallet.

a zid can:

- authenticate you to websites and apps
- sign arbitrary messages
- provide DH keypairs for end-to-end encrypted messaging
- identify you in contact cards for sender authentication

## separation of concerns

zafu uses two distinct systems for two distinct purposes:

| layer | mechanism | purpose |
|-------|-----------|---------|
| diversified address | zcash FVK diversifier | payment routing + referral tracking |
| per-site zid | ed25519 per origin | website authentication |
| per-contact zid | ed25519 per contact | sender auth + e2ee (X25519 DH) |

referral tracking ("via alice") is handled entirely by diversified
zcash addresses at the transport layer. see
[contact cards](contact-cards.md#diversified-addresses) for details.

zid handles identity and encryption - not payment routing.

## derivation

all zid keys are derived deterministically from the wallet mnemonic
using HMAC-SHA512 with a versioned domain separator.

```
root = HMAC-SHA512("zid-v1", mnemonic)
```

from the root, multiple keypairs are derived:

```
global:      HMAC-SHA512(root, 0x00000000)         opt-in only
per-site:    HMAC-SHA512(root, "site:" + origin)    default
rotated:     HMAC-SHA512(root, "site:" + origin + ":" + N)
per-contact: HMAC-SHA512(root, "contact:" + contact_id)
```

the first 32 bytes of each derived value become the ed25519 private
key. the public key is derived from it. all intermediate values are
zeroized after use.

## address format

for display, a zid is shown as:

```
zid + first 16 hex characters of the public key
```

example: `zid8a3f72b1e9c04d5a`

the full 32-byte public key is available for copy/export.

## per-site identity (default)

every website gets a unique zid derived from its origin:

```
zid_for_example = HMAC-SHA512(root, "site:https://example.com")
```

this is the default mode. websites cannot correlate your activity
across sites because they each see a different public key.

you can opt to share your global zid (index 0) with a site if you
want to be recognizable across services. switching to global mode
requires explicit confirmation because it enables cross-origin
linking.

### rotation

you can rotate your identity for a site. this creates a new zid
derived from `"site:" + origin + ":" + N` where N is the rotation
counter. the old identity is not invalidated - the site keeps
whatever pubkeys you previously shared. rotation only affects
future signatures.

## per-contact identity

when you share a contact card, zafu derives a unique zid for that
relationship:

```
zid_for_alice = HMAC-SHA512(root, "contact:" + alice_contact_id)
```

this zid is included in the contact card as a TLV extension
(tag 0x01, 32 bytes). it serves two purposes:

1. **sender authentication** - the recipient can verify that a
   message came from you specifically, not just from "someone who
   knows my address"

2. **key exchange** - the ed25519 key can be converted to X25519
   for Diffie-Hellman key agreement, enabling encrypted messaging
   on top of zcash memos

per-contact zids are NOT used for referral tracking. that's handled
by diversified zcash addresses at the transport layer.

### limitations

**no forward secrecy.** per-contact zid keys are deterministic from
the seed phrase. if the seed is compromised, all past encrypted
messages can be decrypted. a ratchet protocol (like Signal's Double
Ratchet) would fix this but adds significant complexity. for v0.3.0,
the zcash note-level encryption (to the recipient's IVK) provides
the primary confidentiality layer. the zid layer adds sender
authentication on top.

**contactId must be stable.** the per-contact zid is derived from
the contact's internal ID (not their zid pubkey, which may rotate).
changing the ID changes the keypair, breaking e2ee continuity for
that relationship.

## sign-in flow

1. a website sends a sign request: `{ type: "zafu_sign", challengeHex, statement? }`
2. zafu shows an approval popup with the origin, challenge, and which zid will sign
3. you approve or deny
4. if approved, zafu signs the challenge with your per-site zid
5. the signature and pubkey are returned to the website
6. the pubkey is recorded in the encrypted share log

no transaction is created. no funds are at risk. the signature only
proves you control the zid private key.

## connections

each approved site appears in the connections page showing:

- the zid address they know you by (from the share log)
- your network addresses (penumbra, zcash) if applicable
- identity mode (site-specific or global)
- rotation counter and rotate button

switching to global mode shows a warning about cross-origin linking.
rotating shows a notice that the site keeps old identities.

## storage

zid preferences and the share log are encrypted at rest alongside
wallet keys. they are not readable without the wallet password.

| data | encrypted | purpose |
|------|-----------|---------|
| zidPreferences | yes | per-origin mode + rotation counter |
| zidShareLog | yes | site authentication records |
| diversifiedAddresses | yes | per-contact zcash address mapping |
| vault.insensitive.zid | no | global zid pubkey for menu display |

the global zid pubkey in vault metadata is not sensitive - it is
your public identity. preferences, share logs, and address records
are sensitive because they reveal your social graph.

## recovery

because the zid is derived from your seed phrase, it is automatically
recovered when you restore your wallet. the share log, preferences,
and diversified address records are not recoverable from the seed -
they exist only in encrypted local storage.
