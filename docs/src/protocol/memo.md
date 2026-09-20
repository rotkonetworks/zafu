# Zafu Memo Protocol

## Status

Version: 1.0-draft
Date: 2026-03-23
Authors: rotko networks

## Abstract

This document specifies the binary wire format for structured messages
carried inside Zcash shielded memo fields (ZIP-302). The protocol
enables wallet-to-wallet communication including text messaging,
contact card exchange (with ed25519-derived zid extensions), FROST
multisig coordination, and generic machine-to-machine data. An
end-to-end encrypted memo type (0x06) is reserved but not yet
implemented; see [encrypted messaging](encrypted-messaging.md) for the
mechanisms zafu uses today.

## 1. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document
are to be interpreted as described in RFC 2119.

All integers are unsigned and big-endian unless stated otherwise.
All lengths are in bytes.

## 2. Transport Layer

### 2.1. Zcash Memo Field

The Zcash memo field is a 512-byte field attached to each shielded
note (ZIP-302). The first byte determines the interpretation:

    0x00-0xF4  UTF-8 text (strip trailing zero bytes)
    0xF5       Legacy arbitrary data (deprecated)
    0xF6       No memo / reserved
    0xF7-0xFE  Reserved
    0xFF       Arbitrary data (511 unconstrained bytes)

This protocol uses 0xFF (arbitrary data) exclusively.

### 2.2. Zafu Header

Bytes 0-2 of every zafu structured memo:

     0                   1                   2
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |     0xFF      |     0x5A      |     Type      |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

    0xFF   ZIP-302 arbitrary data tag
    0x5A   Zafu magic byte ('Z', identifies zafu protocol)
    Type   Message type (Section 3)

Receivers MUST reject memos where byte 0 is not 0xFF or byte 1
is not 0x5A.

## 3. Message Types

    Value   Name             Description
    -----   ----             -----------
    0x01    Text             UTF-8 text message
    0x02    Address          Unified address (bech32m string)
    0x03    PaymentRequest   Amount + optional address + label
    0x04    Ack              Read receipt / acknowledgment
    0x05    ContactCard      Name + address + TLV extensions
    0x06    EncryptedMessage zid-authenticated encrypted payload
    0x07    Data             Generic structured data (agentic)
    0x10    DkgRound1        FROST DKG round 1
    0x11    DkgRound2        FROST DKG round 2
    0x12    DkgRound3        FROST DKG round 3
    0x20    SignRequest      FROST signing request
    0x21    SignCommitment   FROST signing commitment
    0x22    SignShare        FROST signature share
    0x23    SignResult       FROST aggregated signature

Values 0x00 and 0xF0-0xFF are reserved. Receivers MUST ignore
messages with unknown type values.

## 4. Standalone Messages

Messages that fit in a single memo use a 4-byte header:

     0                   1                   2                   3
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |     0xFF      |     0x5A      |     Type      |     0x00      |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |                                                               |
    |                     Payload (508 bytes max)                   |
    |                                                               |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

Byte 3 is 0x00, indicating a standalone (non-fragmented) message.
Maximum payload: 512 - 4 = 508 bytes.

A standalone message has no explicit Message ID field. When one is
needed internally (Section 5.1), the first 16 bytes of the payload are
used as a deterministic ID, so decoding the same memo twice yields the
same ID.

## 5. Fragmented Messages

Messages exceeding 508 bytes are split across multiple memos.
Each fragment uses a 20-byte header:

     0                   1                   2                   3
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |     0xFF      |     0x5A      |     Type      |  Part | Total |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |                                                               |
    |                     Message ID (16 bytes)                     |
    |                                                               |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |                                                               |
    |                     Payload (492 bytes max)                   |
    |                                                               |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

Byte 3 encodes the sequence: high nibble = part number (1-indexed),
low nibble = total fragment count. A standalone message has byte 3
equal to 0x00 (part=0, total=0).

    Part:  1-15 (4 bits, 1-indexed)
    Total: 1-15 (4 bits)

Maximum fragments: 15
Maximum payload per fragment: 512 - 20 = 492 bytes
Maximum total payload: 15 \* 492 = 7,380 bytes

### 5.1. Message ID

The Message ID is a 16-byte random value generated by the sender.
All fragments of one logical message share the same Message ID.

Receivers MUST group fragments by Message ID and Type. Receivers
MUST reject reassembly if fragment types differ within a group.

### 5.2. Reassembly

Fragments are sorted by Part number. Payloads are concatenated
in order. The result is the complete application-layer payload,
identical in format to a standalone payload.

Receivers MUST NOT deliver incomplete messages to the application
layer. Receivers SHOULD buffer fragments for a reasonable time
(RECOMMENDED: until the next 100 blocks) before discarding
incomplete groups.

### 5.3. Transport

Each fragment is carried in a separate Zcash shielded output note
within the same transaction. This ensures atomic delivery - either
all fragments confirm or none. Each fragment output carries a dust
amount (minimum 1 zatoshi).

## 6. Contact Card (Type 0x05)

### 6.1. Purpose

A contact card allows one wallet to share identity and address
information with another, privately, inside a shielded memo. The
recipient's wallet detects the card and offers to save the sender
as a contact.

### 6.2. Payload Format

     0                   1                   2                   3
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |    Version    |     Flags     |   Name Len    |               |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+               +
    |                        Name (UTF-8)                           |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |        Address Length          |                              |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+                               +
    |                       Address (UTF-8)                         |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |                    TLV Extensions (optional)                  |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

Fields:

    Version (u8):
        0x01. Receivers MUST reject unknown versions.

    Flags (u8):
        Reserved. Senders MUST set to 0x00.
        Receivers MUST ignore all flag bits.
        Capabilities are signaled by extension presence (Section 6.3),
        not flag bits.

    Name Length (u8):
        Length of Name field in bytes. MAY be 0 (anonymous card).
        Maximum: 255.

    Name (variable):
        UTF-8 encoded display name. No null terminator.

    Address Length (u16be):
        Length of Address field in bytes. MUST be > 0.

    Address (variable):
        Zcash unified address (bech32m string). REQUIRED.

### 6.3. TLV Extensions

After the Address field, zero or more TLV extensions MAY follow:

    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |      Tag      |         Length (u16be)         |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |                  Value (Length bytes)          |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

Parsers MUST read extensions until the payload ends. Parsers MUST
skip unknown tags by reading Length and advancing the offset.
Parsers MUST stop if a TLV header would exceed the remaining
payload (truncated extension).

Defined tags:

    Tag    Length   Description
    ---    ------   -----------
    0x01   32       ed25519 zid public key (Section 7)
    0x02   var      Post-quantum public key (reserved, not yet emitted)

The presence of tag 0x01 indicates the sender supports
zid-authenticated messaging. The specific key in the value is the
sender's per-contact zid, unique to this relationship (Section 7.2).
Tag 0x02 is reserved for a post-quantum public key; the wallet does
not yet emit it.

### 6.4. Size Budget

    Fixed overhead:       5 bytes (ver + flags + name_len + addr_len)
    Typical UA:           ~300 bytes
    Typical name:         ~20 bytes
    zid extension:        35 bytes (3 TLV header + 32 pubkey)
    Total:                ~360 bytes (fits single memo)

    With a PQ extension (reserved): an X-Wing public key is 1,216 bytes,
    which pushes the card past a single memo and would require
    fragmentation. Tag 0x02 is not yet emitted.

### 6.5. Design Rationale

    Q: Why binary, not text-delimited?
    A: Names can contain any UTF-8 character including delimiters.
       Length-prefixed binary is unambiguous. More compact in the
       508-byte budget.

    Q: Why not CBOR or protobuf?
    A: 508 bytes is too tight for schema overhead. A 5-byte header
       is trivial to implement and audit.

    Q: Why no encryption on top?
    A: Zcash shielded memos are already encrypted to the recipient's
       incoming viewing key. Redundant encryption wastes bytes.
       Sender authentication is provided by the per-contact zid (tag
       0x01); a fully encrypted memo type is reserved (Section 9).

    Q: Why no checksum?
    A: The Zcash note commitment scheme provides authenticated
       encryption. Bit-flips invalidate the note.

    Q: Why TLV for extensions instead of flag bits?
    A: Flag bits signal boolean capabilities. Extensions carry data
       (public keys, certificates). TLV is self-describing  -
       unknown tags can be skipped without protocol knowledge.
       Same pattern as IPv6 extension headers, DNS, TLS.

## 7. Zafu Identity (zid)

### 7.1. Derivation

A zid is a cross-network ed25519 identity derived deterministically
from the wallet's mnemonic seed phrase. Derivation is a v2 two-stage
KDF that shares no intermediate material with the BIP39 spending seed:

    mnemonic_hash = SHA-256(mnemonic_string)
    zid_seed      = HKDF-SHA256(mnemonic_hash,
                                salt="zafu-zid-v2",
                                info="identity-root", 64)
    identity      = HMAC-SHA512(zid_seed, "identity:" + name)

Keys are then derived under a named identity subtree with tags:

    Per-site zid:
        seed = HMAC-SHA512(identity, encode_utf8("site:" + origin))
        private_key = seed[0:32]
        public_key  = ed25519_public_key(private_key)

    Per-site rotated zid:
        seed = HMAC-SHA512(identity, encode_utf8("site:" + origin + ":" + N))
        N is the rotation counter (decimal string)

    Per-contact zid:
        seed = HMAC-SHA512(identity, encode_utf8("contact:" + contact_id))
        contact_id is any stable unique identifier for the contact
        (in zafu, the contact's internal id).

The shipped wallet uses the identity name "default"; personas are
exposed as reversible generations of that identity (the name becomes
"default-vN" at rotation index N). All intermediate values (zid_seed,
identity, seed, private_key) MUST be zeroized after use.

### 7.2. Per-Contact Identity and Leak Detection

When sharing a contact card, the sender includes a per-contact zid
derived for the recipient (Section 7.1, per-contact derivation).
Each relationship receives a unique public key.

If a contact card is forwarded to a third party, the third party
presents the per-contact zid that was bound to the original
recipient. The sender can detect this by maintaining a mapping:

    { zid_public_key -> recipient_name }

When a previously-unseen party presents a known per-contact zid,
the sender knows which contact forwarded the card.

### 7.3. Address Format

For display, a zid is formatted as:

    "zid" + hex(public_key)[0:16]

Example: zid8a3f72b1e9c04d5a

The full 32-byte public key is available via copy/export.

## 8. Data Messages (Type 0x07)

### 8.1. Purpose

The Data message carries generic structured payloads for
machine-to-machine communication. This enables agentic transactions
where AI agents or automated services exchange structured data
(JSON, CBOR, protobuf) over Zcash shielded memos with built-in
request/response correlation and reply addressing.

### 8.2. Payload Format

     0                   1
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    | Content Type  |     Flags     |   ...
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

Fields:

    Content Type (u8):
        0x00  Raw bytes (interpret by context)
        0x01  JSON (UTF-8)
        0x02  CBOR (RFC 8949)
        0x03  Protobuf (schema out-of-band)

    Flags (u8):
        bit 0: Correlation ID present (16 bytes follow)
        bit 1: Reply-To address present (u16be len + UTF-8 follows)

    Correlation ID (16 bytes, optional):
        Links a response to a prior request. The requester generates
        a random 16-byte ID; the responder echoes it. Present only
        if flags bit 0 is set.

    Reply-To (variable, optional):
        u16be length prefix + UTF-8 Zcash address. Tells the
        recipient where to send a response. Present only if flags
        bit 1 is set.

    Application Data (remaining bytes):
        The actual payload, interpreted per Content Type.

### 8.3. Request/Response Pattern

    Agent A -> Agent B:
        Data { contentType: JSON, correlationId: X, replyTo: addr_A,
               data: {"method": "translate", "text": "..."} }

    Agent B -> Agent A (to addr_A):
        Data { contentType: JSON, correlationId: X,
               data: {"result": "..."} }

    Agent A matches the response by correlationId X.

### 8.4. Atomicity with Payment

A Data memo can be attached to a payment note. This enables
pay-for-service in a single atomic transaction:

    Transaction outputs:
        Note 1: (agent_B, 0.01 ZEC, Data{method: "translate", ...})
        Note 2: (self, change, empty)

    Agent B receives both the payment and the request atomically.

### 8.5. Combining with Encryption

The reserved EncryptedMessage type (0x06, Section 9) is designed so a
Data payload could be wrapped for sender authentication and viewing-key
resistance (its inner plaintext byte 0 = inner MemoType = 0x07). This is
not yet implemented; today the sealed-box and Noise mechanisms in
[encrypted messaging](encrypted-messaging.md) cover authenticated
delivery, off the memo path.

## 9. Encrypted Messages (Type 0x06) - Reserved

Type 0x06 is RESERVED for a future zid-authenticated encrypted memo.
The value is defined in the type table and the inbox renders it as
"encrypted message (decryption not yet supported)", but the wallet
has no encoder for it: no encrypted memo is produced or decrypted
today.

The intent is a memo whose inner plaintext is itself a typed payload
(byte 0 = inner MemoType), adding sender authentication and viewing-key
resistance on top of the note's own encryption. The exact construction
is not yet fixed and MUST NOT be assumed from earlier drafts.

End-to-end encryption in zafu today does NOT ride this memo type. It is
provided by two other mechanisms documented in
[encrypted messaging](encrypted-messaging.md):

    - sealed box: zafu_encrypt / zafu_decrypt (classical x25519 or the
      hybrid X-Wing suite), addressed to a site-scoped zid key
    - a hybrid Noise IK channel over a relay WebSocket (the chat DM
      transport), NOT over memos

## 10. Security Considerations

### 10.1. Memo Privacy

Zcash shielded memos are encrypted to the recipient's incoming
viewing key. An attacker without the viewing key learns nothing.
An attacker WITH the viewing key can read plaintext memos - zafu
structured memos (contact cards, text, FROST) are NOT additionally
encrypted at the memo layer.

### 10.2. Sender Anonymity

Plain memos do not identify the sender. A contact card's per-contact
zid (tag 0x01) reveals the sender's zid to the recipient (intentional
for authentication) but is not visible to network observers - it is
inside the shielded note.

### 10.3. Fragment Integrity

Each fragment is carried in a separate Zcash shielded note. The note
commitment scheme provides authenticated encryption per fragment;
tampering with any fragment invalidates its note.

### 10.4. Per-Contact Zid Correlation

Per-contact zids prevent cross-contact linkability. An attacker who
obtains two contact cards from the same sender (the card sent to
Alice and the card sent to Bob) cannot determine they come from the
same wallet - the per-contact zids are cryptographically independent
(HMAC with different inputs).

## 11. References

    [ZIP-302]   Zcash Memo Field Format
    [RFC 2119]  Key words for use in RFCs
    [RFC 7748]  Elliptic Curves for Security (x25519)
    [RFC 8032]  Edwards-Curve Digital Signature Algorithm (ed25519)
