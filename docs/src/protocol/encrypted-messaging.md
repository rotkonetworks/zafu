# encrypted messaging

zafu does end-to-end encryption in two places, and neither uses a
dedicated encrypted memo type (0x06 is
[reserved](message-types.md#0x06---encryptedmessage), not implemented):

1. **sealed box** - `zafu_encrypt` / `zafu_decrypt`, a one-shot
   encrypt-to-a-key primitive exposed to dapps through `@zafu/zid`.
   classical x25519 or the hybrid post-quantum X-Wing suite.
2. **Noise channel** - a hybrid Noise IK session between two zid
   identities over a relay WebSocket. this is the chat DM transport.

a third surface, the zitadel chat client's public rooms, is NOT
end-to-end encrypted; it relays plaintext and authenticates it with
per-message ed25519 signatures.

all keys derive from the seed via the v2 zid derivation - see
[zid](../identity/zid.md#derivation). signatures stay ed25519; the
post-quantum layer is KEMs only, for confidentiality of key agreement.

## sealed box (zafu_encrypt / zafu_decrypt)

a dapp fetches a recipient's site-scoped keys with `zafu_zid_pubkey`
(ed25519 `pubkey`, plus `pq_pubkey` + `pq_suite` when the wallet
advertises them) and seals a message to them. the wallet holds the
private keys; only the recipient's own wallet can open the box. there is
no sender authentication - like NaCl `crypto_box_seal` / age, the sender
is anonymous.

### classical path

```
recipient_x25519 = ed25519_to_x25519(recipient_zid_pubkey)
e                = random x25519 keypair                  (ephemeral)
ss               = x25519(e.priv, recipient_x25519)
key              = HKDF-SHA256(ss, info="zafu-seal-v1:" + hex(E) + ":" + hex(recipient_x25519), 32)
ciphertext       = AES-256-GCM(key, nonce, plaintext)
```

the response carries the ciphertext (base64) and `ephemeral_pubkey`
(the x25519 `E`, hex) - the recipient needs `E` to open the box. the
HKDF `info` binds the derived key to both public keys, preventing key
confusion. the ephemeral private key is discarded, so a later compromise of the
sender does not expose the message. compromise of the recipient's
long-term key does (a unidirectional channel has no recipient-side
forward secrecy).

on decrypt, the wallet derives the caller-origin's own site-scoped
ed25519 keypair, converts it to x25519, repeats the DH with the supplied
`ephemeral_pubkey`, and opens the box.

### hybrid post-quantum path

when the recipient advertised a `pq_pubkey` (suite `xwing-v1`,
X25519 + ML-KEM-768), the wallet seals with X-Wing so a recorder cannot
decrypt it even with a future quantum computer (harvest-now,
decrypt-later):

```
(ss, xwing_ct) = X-Wing.encapsulate(recipient_pq_pubkey)
key            = HKDF-SHA256(ss, info="zafu-seal-pq-v1", 32)
sealed         = AES-256-GCM(key, nonce, plaintext)
wire           = [0x01 suite][xwing_ct 1120][nonce 12][sealed ct+tag]
```

X-Wing already bundles the ephemeral X25519 and the ML-KEM-768
ciphertext, so the wire needs no separate ephemeral field and
`ephemeral_pubkey` comes back empty (that empty value is how decrypt
knows to take the hybrid path). the recipient opens it with the
site-scoped X-Wing seed (`deriveZidPqSeed`), which is recoverable from
the mnemonic. ML-KEM uses implicit rejection, so a wrong or tampered
ciphertext surfaces as an AEAD failure, not a distinct error.

`@zafu/zid`'s `encryptFor` selects the hybrid path automatically when
`pq_pubkey` is present, and reports which path was actually used; a
caller can pass `requirePq: true` to fail closed rather than emit a
classical (harvest-now-decrypt-later-vulnerable) box.

## Noise channel

the chat DM transport is a hybrid Noise IK session between two zid
ed25519 identities. protocol name:

```
zafuNoise_IKhybrid_25519+MLKEM768_ChaChaPoly_SHA256
```

it is the classical `Noise_IK_25519` handshake with an **ephemeral**
ML-KEM-768 shared secret mixed into the chaining key as the final step,
so the transport keys depend on both the X25519 chain and the ML-KEM
secret. a passive recorder must break both to decrypt. because the
ML-KEM key is fresh per handshake, the post-quantum secret is also
forward-secret. authentication is unchanged - the X25519 static DHs
(es / ss / se) bind the parties' identities; ML-KEM only adds
confidentiality. the distinct protocol name makes a hybrid peer and a
classical (old) peer fail the handshake rather than silently downgrade.

handshake pattern:

```
<- s                       responder static known a priori
-> e, e_pq, es, s, ss       initiator (noise_init, 0x01)
<- e, e_pq(ct), ee, se      responder (noise_resp, 0x02)
[both mix the ML-KEM shared secret last, then split]
```

wire format:

```
0x01 noise_init      [tag][e 32][mlkem_ek 1184][enc s 48][enc payload 16+]
0x02 noise_resp      [tag][e 32][mlkem_ct 1088][enc payload 16+]
0x03 noise_transport [tag][counter BE 8][ciphertext+tag]
```

transport records use ChaCha20-Poly1305 with monotonic 8-byte
big-endian counter nonces (12-byte Noise nonce: 4 zero bytes + 8-byte LE
counter). the init handshake payload is necessarily classical-only (no
shared ML-KEM secret exists yet at that point); only the transport keys
are fully hybrid, so anything needing post-quantum confidentiality
belongs in transport messages, not the init payload.

roles and authentication:

- the initiator is the peer with the lexicographically smaller ed25519
  pubkey.
- the responder verifies the initiator's static key equals the expected
  peer (constant-time compare) and fails closed on mismatch. without
  this, an active party on the untrusted relay could complete a
  fully-encrypted "authenticated" channel with its own key.

these messages ride a relay WebSocket, not zcash memos - the ML-KEM
public key (1184 bytes) and ciphertext (1088 bytes) both exceed a
512-byte memo. the relay routes by the `(from, to)` pubkey pair and sees
only the envelope, never the Noise payloads.

## zitadel chat

zitadel is an in-extension IRC-style chat client (`zitadel.html`) served
locally from the extension. it has two message classes with very
different security:

### public rooms - signed, not encrypted

room messages are **cleartext** to the relay and to anyone it forwards
them to. there is no room-level encryption. instead, every line is
authenticated:

- **zid-auth-v1** - a signed announce binding `(server, nick, pubkey,
ts)`. canonical bytes: `"zafu-zid-auth-v1" 0x00 server 0x00 nick 0x00
pubkey_hex 0x00 ts`. receivers check version, 60s freshness, that the
  server matches the active relay, the ed25519 signature, and
  first-claim-wins for a nick.
- **zid-msg-v1** - a per-line signature carried alongside the text.
  canonical bytes: `"zafu-zid-msg-v1" 0x00 server 0x00 room 0x00 nick
0x00 pubkey 0x00 ts 0x00 text`. it doubles as an implicit announce, so
  every line carries its own authentication and a nick-spoofed unsigned
  line never inherits a verified mark.

so public rooms give non-repudiable, nick-spoof-resistant messaging (the
relay can even prove who said what) but no confidentiality - be honest
with users that room content is visible to the relay.

the chat identity is the site-scoped ed25519 key for origin `zitadel`,
fetched from the service worker (`zafu_zid_keypair`, unlocked wallets
only). the generation-0 pubkey is read from the vault's insensitive
metadata so a locked wallet can still display an identity.

the default relay is `wss://zrelay.rotko.net/ws`; users can switch with
`/server <url>`. channel creation is gated to Pro (channels are
persistent relay state); anyone can join existing channels.

### DMs - end-to-end encrypted

1:1 DMs open a Noise IK channel (above) to the peer's zid pubkey over a
separate `/zid` WebSocket derived from the chat relay URL. they are
end-to-end encrypted between the two zid keypairs and require an unlocked
wallet (the private key is needed for the DH). voice/video call signaling
rides the same DM channel.

## bootstrap primitives (SDK)

`@zafu/zid` also exports two primitives for bootstrapping a Noise
channel out-of-band, used by SDK consumers rather than the wallet UI:

- `noise-init-memo` (`zNI\x01`) - packs an initiator ed25519 pubkey, an
  ephemeral x25519 key, and a relay URL into a <=512-byte blob suitable
  for a zcash memo, letting a responder connect without a round trip.
- `sealed-remark` (`zSR\x01`) - seals such a payload for a public
  channel (e.g. a Polkadot `system.remark`) with an ephemeral-x25519 DH
  to the recipient, hiding the content while leaking that someone
  messaged them.

these carry a classical ephemeral `e` and predate the hybrid handshake;
treat their transport confidentiality as classical.

## memo type 0x06

the encrypted-memo type is
[reserved and unimplemented](memo.md#9-encrypted-messages-type-0x06---reserved).
do not assume any wire format for it.

## references

- [zid](../identity/zid.md) - identity derivation
- [message types](message-types.md) - memo type definitions
- [memo protocol](memo.md) - full protocol specification
- [RFC 7748](https://www.rfc-editor.org/rfc/rfc7748) - x25519
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) - ed25519
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) - HKDF
