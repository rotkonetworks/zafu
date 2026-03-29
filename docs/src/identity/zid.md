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

### named identities

a single seed phrase produces multiple independent identities, each
identified by a stable name. the name is a derivation path component,
not a secret — the mnemonic provides all entropy.

```
root = HMAC-SHA512("zid-v1", mnemonic)

identity["default"]  = HMAC-SHA512(root, "identity:default")
identity["poker"]    = HMAC-SHA512(root, "identity:poker")
identity["personal"] = HMAC-SHA512(root, "identity:personal")
```

identities are unlinkable — no one can determine that two identities
derive from the same seed. users create identities by choosing a name:

- "default" — created automatically for new wallets
- "poker" — gaming pseudonym
- "personal" — friends and family
- "work" — professional contacts

the name is stable. changing it changes the derived keys, which breaks
all connections to sites and contacts under that identity. the user-facing
label (displayed in the UI) can change freely without affecting keys.

### per-identity subtree

each identity has its own complete derivation subtree:

```
identity["poker"]:
  per-site:    HMAC-SHA512(identity, "site:" + origin)       default
  rotated:     HMAC-SHA512(identity, "site:" + origin + ":" + counter)
  per-contact: HMAC-SHA512(identity, "contact:" + contact_id)
  cross-site:  HMAC-SHA512(identity, "cross-site")           opt-in only
```

the first 32 bytes of each derived value become the ed25519 private
key. the public key is derived from it. all intermediate values are
zeroized after use.

**per-site** keys are the default. **cross-site** keys are opt-in only
and require explicit confirmation with a warning about cross-origin
linking. the cross-site key is never displayed on the identity card.

### contacts are scoped to identity

per-contact zids are derived under the identity subtree, not the root.
your "poker" identity's contacts are completely separate from your
"personal" identity's contacts. sharing a contact card from "poker"
produces a different zid than sharing from "personal", even for the
same contact.

## address format

for display, a zid is shown as:

```
zid + first 16 hex characters of the public key
```

example: `zid8a3f72b1e9c04d5a`

the full 32-byte public key is available for copy/export.

## per-site identity (default)

every website gets a unique zid derived from the active identity
and the site's origin:

```
zid_for_example = HMAC-SHA512(identity["poker"], "site:https://example.com")
```

this is the default mode. websites cannot correlate your activity
across sites because they each see a different public key.

### cross-site key (opt-in, dangerous)

each identity has a cross-site key that is the same across all origins.
sharing it enables cross-origin linking within that identity.

```
cross_site = HMAC-SHA512(identity["poker"], "cross-site")
```

this does NOT link across identities — the "poker" cross-site key
cannot be correlated with the "personal" cross-site key.

**this is never shared by default.** switching to cross-site mode for
any origin requires:

1. explicit toggle in identity settings
2. warning dialog: "this links your activity across all sites using
   your [poker] identity. anyone who learns this key can correlate
   your sessions."
3. separate confirmation

the cross-site key is NOT shown on the identity card. it lives in
settings > identity > advanced.

### rotation

you can rotate your identity for a site. this creates a new zid
derived from `"site:" + origin + ":" + N` where N is the rotation
counter. the old identity is not invalidated - the site keeps
whatever pubkeys you previously shared. rotation only affects
future signatures.

## per-contact identity

when you share a contact card, zafu derives a unique zid for that
relationship under the active identity:

```
zid_for_alice = HMAC-SHA512(identity["poker"], "contact:" + alice_contact_id)
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
messages can be decrypted. for poker game channels where session
confidentiality matters, consider ephemeral DH with ratcheting
on top of zid authentication (future work). for v0.3.0, the zcash
note-level encryption provides the primary confidentiality layer.

**no revocation.** a compromised identity cannot signal its
compromise to contacts. rotation creates a new per-site key but
the old key remains valid. a revocation certificate protocol
(sign "revoked, trust new key" with old key) requires a
distribution channel and is planned for a future release.

**contactId must be stable.** the per-contact zid is derived from
the contact's internal ID (not their zid pubkey, which may rotate).
changing the ID changes the keypair, breaking e2ee continuity for
that relationship.

## identity manager

the identity screen shows:

- list of identities with labels ("Personal", "Poker", "Anon")
- create new identity (choose a stable name — cannot change later)
- rename label (display only, does not affect keys)
- delete identity
- active identity indicator
- per-identity: list of connected sites + per-contact zids
- **never** shows the cross-site key on the main screen

switching identities changes which zid apps see on next connection.
existing connections keep whatever identity was used.

### identity selection in apps

when an app requests connection via `zid.connect()`:

1. if only one identity exists, use it automatically
2. if multiple exist, show identity picker popup
3. the user picks which identity to present to this app
4. the choice is remembered per origin

## sign-in flow

1. a website sends a sign request: `{ type: "zafu_sign", challengeHex, statement? }`
2. zafu shows an approval popup with the origin, active identity label, and which per-site zid will sign
3. you approve or deny
4. if approved, zafu signs the challenge with the per-site zid for the active identity
5. the signature and pubkey are returned to the website
6. the pubkey is recorded in the encrypted share log

no transaction is created. no funds are at risk. the signature only
proves you control the zid private key.

## connections

each approved site appears in the connections page showing:

- which identity was used (label + per-site zid)
- your network addresses (penumbra, zcash) if applicable
- rotation counter and rotate button

switching to cross-site mode shows a strong warning.
rotating shows a notice that the site keeps old identities.

## storage

zid preferences and the share log are encrypted at rest alongside
wallet keys. they are not readable without the wallet password.

| data | encrypted | purpose |
|------|-----------|---------|
| zidIdentities | yes | identity names + labels |
| zidPreferences | yes | per-origin identity choice + mode + rotation counter |
| zidShareLog | yes | site authentication records |
| diversifiedAddresses | yes | per-contact zcash address mapping |

all identity information is encrypted. no zid pubkeys are stored
in plaintext vault metadata.

## recovery

because all identities are derived from the seed phrase, they are
automatically recovered when you restore your wallet — provided you
remember the identity names. identity labels, share logs, preferences,
and diversified address records exist only in encrypted local storage
and are not recoverable from the seed alone.

after recovery, you get the same keypairs (for known identity names)
but must re-establish connections to sites and re-share contact cards.
