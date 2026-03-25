# message types

the zafu memo protocol defines 14 message types carried inside zcash
shielded memo fields (ZIP-302). each memo is exactly 512 bytes. byte 0
is 0xFF (arbitrary data), byte 1 is 0x5A (zafu magic), byte 2 is the
message type.

all integers are unsigned and big-endian unless stated otherwise.

## framing

standalone messages use a 4-byte header, leaving 508 bytes for payload:

    byte 0: 0xFF (ZIP-302 arbitrary data)
    byte 1: 0x5A (zafu magic)
    byte 2: message type
    byte 3: 0x00 (standalone)
    bytes 4-511: payload (508 bytes max)

fragmented messages use a 20-byte header, leaving 492 bytes per
fragment:

    byte 0: 0xFF
    byte 1: 0x5A
    byte 2: message type
    byte 3: high nibble = part (1-indexed), low nibble = total
    bytes 4-19: message ID (16 bytes, random, shared across fragments)
    bytes 20-511: payload (492 bytes max)

maximum fragments: 15. maximum total payload: 15 * 492 = 7,380 bytes.
all fragments of one logical message share the same message ID and type.
reassembly sorts by part number and concatenates payloads.

any message type can be fragmented. fragmentation is automatic when the
payload exceeds 508 bytes.

## type table

    value   name              description
    -----   ----              -----------
    0x01    Text              UTF-8 text message
    0x02    Address           unified address share
    0x03    PaymentRequest    amount + optional address + label
    0x04    Ack               read receipt / acknowledgment
    0x05    ContactCard       name + address + TLV extensions
    0x06    EncryptedMessage  zid-authenticated encrypted payload
    0x07    Data              generic structured data
    0x10    DkgRound1         FROST DKG round 1
    0x11    DkgRound2         FROST DKG round 2
    0x12    DkgRound3         FROST DKG round 3
    0x20    SignRequest       FROST signing request
    0x21    SignCommitment    FROST signing commitment
    0x22    SignShare         FROST signature share
    0x23    SignResult        FROST aggregated signature

values 0x00 and 0xF0-0xFF are reserved. receivers must ignore messages
with unknown type values.

## 0x01 - text

UTF-8 text message. the payload is raw UTF-8 bytes with no length
prefix. trailing zero bytes are stripped on decode.

    payload: UTF-8 text (no null terminator)
    max single: 508 bytes (~508 ASCII chars, ~170 CJK chars)
    fragmentation: automatic if text exceeds 508 bytes
    max fragmented: 7,380 bytes

for standalone messages, the message ID used internally is the first 16
bytes of the payload (deterministic). for fragmented messages, a random
16-byte message ID is generated.

## 0x02 - address

a zcash unified address encoded as a UTF-8 bech32m string. no length
prefix - the entire payload is the address string.

    payload: UTF-8 bech32m address
    max: 508 bytes (sufficient for all current UA configurations)
    fragmentation: not expected in practice

## 0x03 - paymentrequest

a payment request carrying an amount and optional metadata. the payload
structure is:

    byte 0-7:   amount in zatoshis (u64be)
    byte 8:     flags (bit 0 = address present, bit 1 = label present)
    if address: u16be length + UTF-8 address
    if label:   u16be length + UTF-8 label

the amount field is always 8 bytes. when no specific address is
provided, the sender expects payment to the address that received this
memo (the diversified address of the conversation).

    max single: 508 bytes
    fragmentation: supported but unlikely needed

## 0x04 - ack

read receipt acknowledging a previously received message. the payload
contains the message ID of the message being acknowledged.

    payload: 16 bytes (message ID of the acknowledged message)
    size: always fits in a single memo (16 bytes << 508)
    fragmentation: never needed

the ack confirms the recipient's wallet has received and processed a
message. it does not imply the user has read it.

## 0x05 - contactcard

a contact card for sharing identity and address information. see the
[memo protocol spec](memo.md) section 6 for the full wire format.

### payload format

    offset  size    field
    0       1       version (0x01)
    1       1       flags (reserved, must be 0x00)
    2       1       name_len (u8)
    3       var     name (UTF-8, name_len bytes)
    3+NL    2       addr_len (u16be)
    5+NL    var     address (UTF-8, addr_len bytes)
    5+NL+AL var     TLV extensions (until payload end)

### fields

- **version**: 0x01. receivers must reject unknown versions.
- **flags**: reserved. senders must set to 0x00. receivers must ignore.
- **name_len**: u8. may be 0 (anonymous card). max 255.
- **name**: UTF-8 display name. no null terminator.
- **addr_len**: u16be. must be > 0.
- **address**: zcash unified address (bech32m). required.

### TLV extensions

after the address, zero or more TLV entries may follow:

    tag (u8) | length (u16be) | value (length bytes)

parsers must skip unknown tags by reading the length and advancing.

    tag    length   description
    ---    ------   -----------
    0x01   32       ed25519 zid public key (signals DH messaging capability)
    0x02   var      post-quantum public key (reserved, format TBD)

the presence of tag 0x01 indicates the sender supports zid-authenticated
encrypted messaging (type 0x06). the key in the value is the sender's
per-contact zid, unique to this relationship. see
[encrypted messaging](encrypted-messaging.md) for details.

### size budget

    fixed overhead:       5 bytes (ver + flags + name_len + addr_len)
    typical UA:           ~300 bytes
    zid extension:        35 bytes (3 header + 32 pubkey)
    typical total:        ~360 bytes (fits single memo)
    with PQ extension:    ~1,260 bytes (requires fragmentation)

name length is capped at u8 (255 bytes). address length is u16be (up to
65,535 bytes) because zcash unified addresses with multiple receiver
types (orchard + sapling + transparent) can exceed 255 bytes.

## 0x06 - encryptedmessage

zid-authenticated encrypted payload providing sender authentication and
viewing-key resistance on top of zcash's shielded encryption. see
[encrypted messaging](encrypted-messaging.md) for the full
specification.

### wire format (payload after zafu header)

    offset  size    field
    0       32      sender zid public key (ed25519)
    32      32      ephemeral public key (x25519)
    64      12      nonce
    76      var     ciphertext + GCM tag (16 bytes)

    overhead: 76 + 16 = 92 bytes
    plaintext capacity (single memo): 508 - 92 = 416 bytes
    plaintext capacity (fragmented): up to 7,288 bytes

the inner plaintext is a typed payload:

    byte 0:    inner MemoType
    bytes 1-N: inner payload

any message type can be encrypted, including Text, ContactCard, and
Data.

## 0x07 - data

generic structured data for machine-to-machine communication. supports
content type tagging, request/response correlation, and reply-to
addressing.

### payload format

    offset  size    field
    0       1       content type (DataContentType)
    1       1       flags
    2       var     conditional fields (per flags)
    var     var     application data

### content types

    value   name       description
    -----   ----       -----------
    0x00    Raw        raw bytes, interpret by context
    0x01    Json       JSON (UTF-8 encoded)
    0x02    Cbor       CBOR (RFC 8949)
    0x03    Protobuf   protobuf (schema defined out-of-band)

### flags

    bit 0: correlation ID present (16 bytes follow immediately after flags)
    bit 1: reply-to address present (u16be length + UTF-8 address follows)

### conditional fields

when flags bit 0 is set, 16 bytes of correlation ID follow the flags
byte. the requester generates a random correlation ID; the responder
echoes it to link the response.

when flags bit 1 is set, a reply-to address follows (after the
correlation ID if present). the format is u16be length prefix + UTF-8
zcash address. this tells the recipient where to send a response.

### layout examples

minimal data message (no correlation, no reply-to):

    [content_type: 1 byte] [flags: 0x00] [application data]

data message with correlation ID:

    [content_type] [flags: 0x01] [correlation_id: 16 bytes] [data]

data message with both correlation and reply-to:

    [content_type] [flags: 0x03] [correlation_id: 16 bytes]
    [reply_to_len: u16be] [reply_to: UTF-8] [data]

### fragmentation

data messages fragment automatically when the total payload (content
type + flags + conditional fields + application data) exceeds 508 bytes.
max total payload with fragmentation: 7,380 bytes.

## FROST types (0x10-0x12) - DKG

FROST distributed key generation is carried over three rounds, each in
its own memo type. payloads are raw binary blobs (hex-decoded FROST
protocol messages).

### 0x10 - DkgRound1

round 1 broadcast: each participant publishes their commitments.
payload is the serialized round 1 package.

    payload: FROST round 1 package (binary)
    fragmentation: automatic if package exceeds 508 bytes

### 0x11 - DkgRound2

round 2: each participant sends their secret shares to specific
recipients. payload is the serialized round 2 package.

    payload: FROST round 2 package (binary)
    fragmentation: automatic if package exceeds 508 bytes

### 0x12 - DkgRound3

round 3: verification and finalization. payload is the serialized
round 3 package.

    payload: FROST round 3 package (binary)
    fragmentation: automatic if package exceeds 508 bytes

all DKG round messages are sent as shielded memos to specific
participants. the zcash diversified address identifies the DKG session
endpoint.

## FROST types (0x20-0x23) - signing

FROST threshold signing uses four message types for the signing
ceremony.

### 0x20 - SignRequest

a signing request containing the sighash and alpha values. the
coordinator sends this to each signer.

    payload layout:
        bytes 0-31:   sighash (32 bytes)
        bytes 32-N:   alpha values (N * 32 bytes, one per input)

    total size: 32 + (num_inputs * 32) bytes
    fragmentation: automatic for transactions with many inputs

### 0x21 - SignCommitment

a signer's nonce commitment for the signing round. each signer responds
to a SignRequest with their commitment.

    payload: serialized FROST signing commitment (binary)
    fragmentation: automatic if needed

### 0x22 - SignShare

a signer's partial signature share. sent after the coordinator
broadcasts all commitments.

    payload: serialized FROST signature share (binary)
    fragmentation: automatic if needed

### 0x23 - SignResult

the aggregated signature, broadcast by the coordinator after collecting
sufficient shares.

    payload: serialized FROST aggregate signature (binary)
    fragmentation: automatic if needed

## references

- [memo protocol](memo.md) - full protocol specification
- [encrypted messaging](encrypted-messaging.md) - type 0x06 details
- [ZIP-302](https://zips.z.cash/zip-0302) - zcash memo field format
