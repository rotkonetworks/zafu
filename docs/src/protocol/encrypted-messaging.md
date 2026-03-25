# encrypted messaging

zafu encrypted messages (type 0x06) provide sender authentication and
viewing-key resistance on top of zcash's shielded memo encryption. this
document covers the cryptographic construction, wire format, capability
negotiation, and forward secrecy properties.

## motivation

zcash shielded memos are encrypted to the recipient's incoming viewing
key. this provides confidentiality against network observers but has two
limitations:

1. no sender authentication. the recipient cannot verify who sent a
   memo. any party knowing the recipient's address can send memos that
   appear identical.

2. viewing key exposure reveals all history. if the recipient shares or
   leaks their viewing key (for compliance, auditing, or compromise),
   all past memo content is exposed.

encrypted messages address both by adding a second encryption layer
using zid-derived keys.

## zid derivation

a zid is a cross-network ed25519 identity derived deterministically from
the wallet mnemonic. all derivations use HMAC-SHA512.

    root = HMAC-SHA512("zid-v1", encode_utf8(mnemonic))

four derivation paths exist:

    global (index 0):
        seed = HMAC-SHA512(root, 0x00000000)
        private_key = seed[0:32]
        public_key = ed25519_public_key(private_key)

    per-site:
        seed = HMAC-SHA512(root, encode_utf8("site:" + origin))

    per-site rotated:
        seed = HMAC-SHA512(root, encode_utf8("site:" + origin + ":" + N))
        N is the rotation counter (decimal string)

    per-contact:
        seed = HMAC-SHA512(root, encode_utf8("contact:" + contact_id))
        contact_id is the counterparty's zid public key (hex) or any
        stable unique identifier

all intermediate values (root, seed, private_key) must be zeroized
after use. the implementation in `identity.ts` calls `.fill(0)` on
every intermediate buffer.

### per-contact zid for leak detection

when sharing a contact card, the sender derives a per-contact zid bound
to the recipient. each relationship receives a unique public key. if a
contact card is forwarded to a third party, the third party presents the
per-contact zid that was bound to the original recipient. the sender can
detect this by maintaining a mapping of per-contact zid public keys to
recipient names.

### display format

for display, a zid is formatted as `"zid" + hex(public_key)[0:16]`.
example: `zid8a3f72b1e9c04d5a`. the full 32-byte public key is
available via copy/export.

## ed25519 to x25519 conversion

ed25519 keys are signing keys. diffie-hellman requires x25519 keys. the
conversion follows RFC 7748 and the birational map between
twisted-edwards and montgomery curves:

    ed25519 private key -> x25519 private key:
        clamp the SHA-512 hash of the ed25519 seed (standard x25519
        scalar clamping: clear bits 0, 1, 2, 255; set bit 254)

    ed25519 public key -> x25519 public key:
        convert the edwards point (x, y) to montgomery u-coordinate:
        u = (1 + y) / (1 - y) mod p

this is a standard conversion implemented in libsodium
(`crypto_sign_ed25519_pk_to_curve25519`) and in the `@noble/curves`
library used by zafu.

the conversion is deterministic - a given ed25519 keypair always
produces the same x25519 keypair. no additional key material is stored.

## cryptographic construction

the encryption uses two diffie-hellman shared secrets combined via HKDF
to produce the message key.

### inputs

    sender_zid:    ed25519 keypair (from per-contact derivation)
    recipient_zid: ed25519 public key (from received contact card)

### key agreement

    // convert ed25519 keys to x25519
    x_s = ed25519_to_x25519_private(sender_zid.private_key)
    X_r = ed25519_to_x25519_public(recipient_zid.public_key)

    // generate ephemeral x25519 keypair
    e = random_x25519_scalar()
    E = x25519_basepoint(e)

    // two shared secrets
    ss1 = x25519(e, X_r)         // ephemeral-static (forward-secret)
    ss2 = x25519(x_s, X_r)       // static-static (sender-authenticated)

    // key derivation
    key = HKDF-SHA256(salt="zid-msg-v1", ikm=ss1 || ss2, length=32)

### encryption

    nonce = random(12)
    ciphertext = AES-256-GCM(key, nonce, plaintext)

the GCM tag (16 bytes) is appended to the ciphertext.

### why two shared secrets

ss1 alone would provide forward secrecy but no sender authentication -
anyone can generate an ephemeral key. ss2 alone would provide sender
authentication but no forward secrecy - compromise of either long-term
key reveals all messages.

combining both means the recipient can verify the sender (only the
holder of x_s can produce ss2) while maintaining sender-side forward
secrecy (the ephemeral key e is discarded after use).

## wire format

the encrypted message payload (after the 4-byte zafu header) is:

    offset  size    field
    0       32      sender zid public key (ed25519, uncompressed)
    32      32      ephemeral public key (x25519)
    64      12      nonce (random)
    76      var     ciphertext
    N-16    16      GCM authentication tag

total overhead: 76 bytes header + 16 bytes tag = 92 bytes.

### capacity

    single memo:     508 - 92 = 416 bytes plaintext
    fragmented:      up to (15 * 492) - 92 = 7,288 bytes plaintext

fragmentation uses the standard zafu fragmentation mechanism - the
entire encrypted payload (sender key + ephemeral key + nonce +
ciphertext + tag) is split across fragments. reassembly produces the
complete encrypted blob before decryption.

### inner plaintext format

    byte 0:    inner MemoType
    bytes 1-N: inner payload

any message type can be wrapped. common inner types:

    0x01  Text         - authenticated text message
    0x05  ContactCard  - encrypted contact exchange
    0x07  Data         - authenticated machine-to-machine payload

## decryption

the recipient:

1. reads the sender's ed25519 zid public key (bytes 0-31)
2. looks up the sender in their contact list
3. converts keys to x25519:
   - their own ed25519 private key to x25519 private
   - the sender's ed25519 public key to x25519 public
4. computes shared secrets:
   - ss1 = x25519(recipient_private, ephemeral_public)
   - ss2 = x25519(recipient_private, sender_x25519_public)
5. derives the key: HKDF-SHA256("zid-msg-v1", ss1 || ss2, 32)
6. decrypts with AES-256-GCM using the nonce at bytes 64-75
7. verifies the GCM tag
8. parses the inner MemoType and payload

note that ss1 and ss2 from the recipient's perspective produce the same
values as the sender's computation due to the commutativity of
diffie-hellman: x25519(e, X_r) = x25519(r, E) and
x25519(x_s, X_r) = x25519(x_r, X_s).

## capability negotiation

encrypted messaging requires no explicit handshake or capability
negotiation. the mechanism is implicit:

1. alice sends bob a contact card (type 0x05) containing TLV tag 0x01
   with her per-contact ed25519 zid public key (32 bytes).

2. bob's wallet parses the TLV extensions. the presence of tag 0x01
   signals that alice supports zid-authenticated messaging.

3. bob can now send encrypted messages (type 0x06) to alice using her
   zid public key for the DH computation.

4. if bob's contact card also included tag 0x01, alice can send
   encrypted messages to bob.

the presence of the zid public key in the contact card IS the capability
signal. no flag bits, version bumps, or protocol negotiation are
involved.

wallets should default to encrypted messages when both parties have
exchanged zid-bearing contact cards. wallets may fall back to plaintext
for contacts without a zid.

### upgrading to encrypted messaging

if an existing contact sends a new contact card with tag 0x01 (where the
previous card had no zid), the wallet upgrades the contact and begins
using encrypted messages for subsequent communication. no user
interaction is needed beyond the initial contact card exchange.

## forward secrecy properties

### sender-side forward secrecy

the ephemeral x25519 key (e) is generated per message and discarded
immediately after computing ss1. if the sender's long-term zid private
key is compromised after sending, the attacker cannot recover e and
therefore cannot compute ss1. past messages remain secure.

### recipient-side limitation

compromise of the recipient's long-term zid private key reveals all past
messages to that recipient. the attacker can:

1. recover the ephemeral public key E from the memo (bytes 32-63)
2. compute ss1 = x25519(recipient_private, E)
3. recover the sender's zid public key from the memo (bytes 0-31)
4. convert it to x25519 and compute ss2 = x25519(recipient_private,
   sender_x25519_public)
5. derive the message key and decrypt

this is a fundamental limitation of unidirectional channels. the
recipient contributes no ephemeral key material, so all messages to a
given recipient share the same long-term decryption capability.

### comparison to bidirectional protocols

full forward secrecy (as in Signal's double ratchet) requires both
parties to contribute fresh ephemeral keys before each message. this
requires a bidirectional exchange, which is not available in zcash memos
without a round trip.

the zafu protocol is designed for asynchronous, unidirectional messaging
where the recipient may be offline. the trade-off is intentional:
sender-side forward secrecy with no round-trip overhead, at the cost of
no recipient-side forward secrecy.

### future work

once both parties have exchanged at least one message each (establishing
a bidirectional channel), a ratcheting protocol can be layered on top to
achieve full forward secrecy for subsequent messages. this would require
each message to include the sender's next ephemeral public key, enabling
a DH ratchet.

## security considerations

### viewing key compartmentalization

zcash viewing keys reveal memo contents. zid-encrypted messages add a
second layer - an attacker with the viewing key sees the encrypted blob
(sender zid + ephemeral key + ciphertext) but cannot decrypt without the
recipient's zid private key.

this is useful when sharing viewing keys for compliance or auditing while
keeping message content private.

### sender identity exposure

the sender's zid public key is included in plaintext (within the
zcash-encrypted note). the recipient learns the sender's identity. this
is intentional - authentication requires identification.

network observers cannot see the sender's zid because it is inside the
zcash shielded note.

### replay protection

each message uses a random 12-byte nonce for AES-256-GCM. the
probability of nonce collision is negligible (2^-48 after 2^24
messages). additionally, each zcash note has a unique nullifier that
prevents double-spending, which provides transaction-level replay
protection.

### cross-contact unlinkability

per-contact zid derivation ensures that the sender's zid public key
differs for each contact. an attacker who obtains contact cards from two
different relationships cannot determine they originate from the same
wallet. the per-contact zids are cryptographically independent
(HMAC-SHA512 with different inputs).

## references

- [message types](message-types.md) - all memo type definitions
- [memo protocol](memo.md) - full protocol specification
- [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748) - x25519
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) - ed25519
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) - HKDF
