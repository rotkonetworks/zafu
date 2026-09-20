# zid - zafu identity

## what is a zid

a zid is a cross-network identity derived from your wallet seed phrase.
it is not tied to any specific blockchain - it is the cryptographic
identity of the person behind the wallet.

a zid has two halves, derived from the same seed but kept separate by
algorithm:

- an **ed25519** keypair for signing and authentication
- a companion **X-Wing** (X25519 + ML-KEM-768) keypair for encryption /
  key agreement

signatures stay ed25519 (classical): a signature cannot be forged
retroactively once it has verified, so authentication has no
harvest-now-decrypt-later exposure. the post-quantum layer is KEMs only,
for confidentiality of key agreement (see
[encrypted messaging](../protocol/encrypted-messaging.md)).

a zid can:

- authenticate you to websites and apps (`zafu_sign`)
- provide a sealed-box encryption key to dapps (`zafu_zid_pubkey`)
- identify you in contact cards for sender authentication
- derive keys for end-to-end encrypted messaging

## separation of concerns

zafu uses distinct mechanisms for distinct purposes:

| layer               | mechanism                    | purpose                             |
| ------------------- | ---------------------------- | ----------------------------------- |
| diversified address | zcash FVK diversifier        | payment routing + referral tracking |
| per-site zid        | ed25519 per origin           | website authentication              |
| per-site pq key     | X-Wing (X25519 + ML-KEM-768) | sealed-box encryption to a site     |
| per-contact zid     | ed25519 per contact          | sender auth + e2ee (x25519 DH)      |
| contact ka key      | x25519 (one per identity)    | non-interactive contact discovery   |

referral tracking ("via alice") is handled by diversified zcash
addresses at the transport layer. see
[contact cards](contact-cards.md#referral-display) for details. zid
handles identity and encryption - not payment routing.

## derivation

all zid keys are derived deterministically from the wallet mnemonic.
derivation is a **v2** two-stage KDF that shares zero intermediate
material with the wallet's BIP39 spending seed:

```
mnemonic_hash = SHA-256(mnemonic_string)
zid_seed      = HKDF-SHA256(mnemonic_hash, salt="zafu-zid-v2", info="identity-root", 64)
identity[name]= HMAC-SHA512(zid_seed, "identity:" + name)
```

the mnemonic string is hashed directly - the BIP39 seed
(`PBKDF2(mnemonic, ...)`) that spending keys use is never touched, so a
`zid_seed` can be handed over without exposing wallet spending keys.

### per-identity subtree

each named identity has its own derivation subtree. tags select the key:

```
identity[name]:
  per-site:     HMAC-SHA512(identity, "site:" + origin)              default
  rotated:      HMAC-SHA512(identity, "site:" + origin + ":" + N)
  cross-site:   HMAC-SHA512(identity, "cross-site")                  opt-in
  per-contact:  HMAC-SHA512(identity, "contact:" + contact_id)
  site pq seed: HMAC-SHA512(identity, "xwing-site\0" + origin + "\0" + N)
  contact ka:   HMAC-SHA512(identity, "contact-ka-v1")
```

for the ed25519 keys, the first 32 bytes of the derived value become the
ed25519 private key; the public key follows from it. the `xwing-site`
tag's first 32 bytes are the X-Wing seed (the ML-KEM-768 + X25519
decapsulation secret). all intermediate values are zeroized (`.fill(0)`)
after use.

named identities are a derivation capability: the same seed can produce
independent, unlinkable subtrees ("default", "poker", ...) by name. in
the shipped wallet the identity name is `default`; personas are exposed
as reversible **generations** of that identity rather than as a
free-form persona picker (see [generations](#generations-and-rotation)).

### post-quantum site key

alongside every per-site ed25519 key, an identity derives a per-site
X-Wing keypair (suite `xwing-v1`, `ml_kem768_x25519`). its 1216-byte
public (encapsulation) key is advertised to dapps as
`zafu_zid_pubkey.pq_pubkey`; the 32-byte seed is the decapsulation
secret and stays in the wallet. the `xwing-site` tag is domain-separated
from `site:` so the two algorithms never share key material.

## generations and rotation

the wallet keeps a single global rotation counter (`zidIndex`). at index
0 the identity name is used unchanged; at index N the name becomes
`default-vN`, which reseeds the whole subtree. rotating is a reversible
"morph": every generation is a deterministic derivation from its index,
so rotating up creates a fresh identity universe and rotating back down
(or jumping to a **pin** - a bookmarked generation with a label)
restores an earlier one exactly. rotation is never a one-way burn.

ring-VRF, multisig, license, and escrow identities deliberately do NOT
follow this rotation - they stay pinned to their creation generation so
funds and subscriptions cannot "rotate away".

### per-site (default)

every website gets a unique zid derived from the active identity and the
site's origin. websites cannot correlate your activity across sites
because each sees a different public key. a per-origin rotation counter
lets you rotate the key for one site without touching others; the old
key is not invalidated (the site keeps whatever you previously shared).

### cross-site key (opt-in, dangerous)

each identity also has a single cross-site key, the same across all
origins. sharing it lets sites collude to link your sessions within that
identity (it does NOT link across identities/generations). it is opt-in
per origin, buried under settings, and never displayed by default.

### per-contact identity

when you share a contact card, zafu derives a unique zid for that
relationship: `HMAC-SHA512(identity, "contact:" + contact_id)`. it is
derived under the `default` identity at generation 0 and does **not**
follow global rotation, so the per-contact key is stable across
generation changes. it serves two purposes:

1. **sender authentication** - the recipient can verify a message came
   from you specifically, not just from someone who knows your address
2. **key exchange** - the ed25519 key can be converted to x25519 for
   Diffie-Hellman, enabling encrypted messaging on top of zcash memos

`contact_id` must be stable for the lifetime of the relationship;
changing it changes the keypair.

## address format

for display, a zid is shown as `"zid"` + the first 16 hex characters of
the ed25519 public key, e.g. `zid8a3f72b1e9c04d5a`. the full 32-byte
public key is available for copy/export.

## dapp protocol

websites talk to the wallet through the versioned `@zafu/protocol`
contract (wire major `ZAFU_PROTOCOL_VERSION = 1`), usually via the
`@zafu/zid` SDK. the v1 method set is:

| method                    | purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `ping`                    | detect wallet + negotiate protocol version      |
| `zafu_sign`               | sign a challenge with the site-scoped zid       |
| `zafu_zid_pubkey`         | fetch the site's ed25519 + pq public keys       |
| `zafu_request_capability` | request a named capability                      |
| `zafu_encrypt`            | seal a message to a recipient (classical or pq) |
| `zafu_decrypt`            | open a sealed box addressed to this site        |
| `zafu_pick_contacts`      | open the wallet's contact picker                |

`ping` reports the wallet release version and every protocol major it
supports, so an SDK can refuse to talk to an incompatible wallet.
encryption and signing require the origin to hold the relevant
capability (an approval popup on first use); external calls are gated to
top-frame https senders and rate-limited to 100 calls/minute/origin.
FROST/multisig methods are deliberately excluded from the general dapp
surface.

## sign-in flow

1. a website sends `{ type: "zafu_sign", challengeHex, statement? }`
2. zafu shows an approval popup with the origin and which per-site zid
   will sign
3. on approval, zafu signs the challenge with the per-site ed25519 key
   for the active generation and returns `{ signature, publicKey }`

no transaction is created and no funds are at risk - the signature only
proves control of the zid private key.

> **security:** the signature covers only `challengeHex`. the wallet
> displays the calling origin but does NOT bind it into the signed
> bytes. a relying party MUST make the challenge unforgeable and
> non-replayable itself - sign a fresh, server-issued nonce that commits
> to the origin/audience (SIWE-style), never a static string. a
> signature over challenge C is valid at any site that presents C.

## connections

each approved site appears in the identity screen showing which
generation was used (label + per-site zid), a per-site rotation control,
and whether the site is in cross-site mode (with a strong warning). the
identity screen also shows the active generation as a keycard on a stack
of its sibling generations, with rotate up/down and pin controls.

## storage

zid preferences and logs live in local extension storage. secrets are
never stored - all private keys are re-derived from the seed on demand.

| data                 | encrypted | purpose                                              |
| -------------------- | --------- | ---------------------------------------------------- |
| zidPreferences       | yes       | per-origin identity choice + mode + rotation counter |
| zidShareLog          | yes       | site authentication records                          |
| zidSiteLabels        | yes       | user labels for connected sites                      |
| diversifiedAddresses | yes       | per-contact zcash address mapping (referral graph)   |
| zidIndex             | no        | global generation counter (non-secret)               |
| zidPins              | no        | bookmarked generations + labels (non-secret)         |
| zidGenKeys           | no        | cached public keys per generation (non-secret)       |

the generation-0 zid **public** key is also stored in the vault's
insensitive metadata so pages like the chat client can read it without
the wallet password. no private key material is ever persisted.

## recovery

because all keys derive from the seed phrase, they are recovered when
you restore your wallet. identity labels, pins, share logs, preferences,
and diversified-address records live only in local storage and are not
recoverable from the seed alone. after recovery you get the same
keypairs but must re-establish site connections and re-share contact
cards.

## limitations

- **no forward secrecy on the static keys.** per-site and per-contact
  keys are deterministic from the seed; a compromised seed can decrypt
  past sealed boxes addressed to those keys. the Noise DM channel adds
  ephemeral forward secrecy on top (see
  [encrypted messaging](../protocol/encrypted-messaging.md)).
- **no revocation.** a compromised identity cannot signal its
  compromise; rotation creates new keys but old ones remain valid. a
  revocation-certificate protocol is future work.
- **stable contactId required.** changing a contact's internal id
  changes the per-contact keypair and breaks e2ee continuity.
