# zid - zafu identity

## what is a zid

a zid is a cross-network ed25519 identity derived from your wallet
seed phrase. it is not tied to any specific blockchain - it is the
cryptographic identity of the person behind the wallet.

a zid can:

- authenticate you to websites and apps
- sign arbitrary messages
- identify you in contact cards
- enable encrypted messaging between wallets
- detect if someone forwarded your contact information

## derivation

all zid keys are derived deterministically from the wallet mnemonic
using HMAC-SHA512 with a versioned domain separator.

```
root = HMAC-SHA512("zid-v1", mnemonic)
```

from the root, multiple keypairs are derived:

```
global:      HMAC-SHA512(root, 0x00000000)
per-site:    HMAC-SHA512(root, "site:" + origin)
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

## per-contact identity

when you share a contact card with someone, zafu derives a unique
zid for that relationship:

```
zid_for_alice = HMAC-SHA512(root, "contact:" + alice_zid_pubkey)
```

if alice forwards your card to bob, bob will present the zid you
created for alice. you can detect the forwarding because you know
which zid was given to which contact.

this is like giving each person a different phone number. if spam
arrives on the number you only gave to your dentist, you know who
shared it.

## per-site identity

by default, each website gets a unique zid derived from its origin:

```
zid_for_example = HMAC-SHA512(root, "site:https://example.com")
```

websites cannot correlate your activity across sites because they
each see a different public key.

you can opt to share your global zid (index 0) with a site if you
want to be recognizable across services.

## sign-in flow

1. a website sends a sign request: `{ type: "zafu_sign", challengeHex, statement? }`
2. zafu shows an approval popup with the origin and challenge
3. you approve or deny
4. if approved, zafu signs the challenge with your zid and returns the signature
5. the website verifies the signature against your public key

no transaction is created. no funds are at risk. the signature only
proves you control the zid private key.

## recovery

because the zid is derived from your seed phrase, it is automatically
recovered when you restore your wallet. no separate backup is needed.
