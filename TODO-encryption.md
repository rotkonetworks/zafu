# zafu encryption design

this document describes the end-to-end encryption architecture for zafu wallet.
zafu acts as an identity + encryption provider for apps. keys never leave the
extension. apps see only opaque ciphertext.

authored in the spirit of: if you can't explain the threat model, you don't
have one.

---

## threat model

**trusted**: the user's device (extension sandbox), the ZID key material in the
vault.

**untrusted**: relays (poker.zk.bot or any WebSocket relay), the delivery
service, other group members' future behavior (forward secrecy matters), any
app calling the external API.

**adversary capabilities**: passive network observer, compromised relay
(can reorder/drop/inject messages but cannot forge signatures), compromised
group member (should not reveal past messages - forward secrecy).

**non-goals for v1**: protection against a compromised device (if the attacker
has your extension memory, it's over), quantum resistance (we use x25519 which
is not post-quantum, acceptable for now).

---

## 1. noise IK channel (replaces raw DH)

### why noise IK

the current `packages/zid/src/channel.ts` does a single x25519 DH, signs the
ephemeral key with ed25519, and derives an AES-256-GCM session key. this is
sound but has no forward secrecy - if the session key leaks, all messages in
that session are exposed.

Noise IK solves this:
- **I** = initiator's static key is transmitted (we send our ZID pubkey)
- **K** = responder's static key is known (we already have their ZID pubkey)
- one round-trip handshake, then full duplex encrypted transport
- ephemeral-ephemeral DH provides forward secrecy
- static-ephemeral DH provides authentication
- no certificates, no PKI, no CA chain

Noise IK message pattern:
```
  <- s
  ...
  -> e, es, s, ss
  <- e, ee, se
```

after handshake: both parties have two symmetric cipher states
(one per direction) with independent keys. each message increments
a nonce counter (no nonce reuse possible without state reset).

### ed25519 to x25519 conversion

ZID keys are ed25519. Noise needs x25519 static keys. the conversion is:
```
x25519_pub = crypto_sign_ed25519_pk_to_curve25519(ed25519_pub)
x25519_priv = crypto_sign_ed25519_sk_to_curve25519(ed25519_priv)
```

this is a standard, safe operation. the ed25519 key continues to be used for
all signing operations (ZID auth, transaction signing). x25519 is used only
inside the Noise handshake.

### wire format

handshake and transport messages use a minimal binary framing over the
existing relay WebSocket:

```
handshake message (initiator -> responder):
  [1 byte: 0x01 = noise_init]
  [32 bytes: initiator ephemeral pubkey (e)]
  [48 bytes: encrypted initiator static pubkey (s) + tag]
  [N bytes: encrypted payload + tag]

handshake message (responder -> initiator):
  [1 byte: 0x02 = noise_resp]
  [32 bytes: responder ephemeral pubkey (e)]
  [N bytes: encrypted payload + tag]

transport message (either direction):
  [1 byte: 0x03 = noise_transport]
  [8 bytes: big-endian nonce counter]
  [N bytes: ciphertext + tag]
```

the relay routes by `(from, to)` pubkey pair. it sees the outer envelope
(who is talking to whom) but not the Noise payloads.

### transport encryption

after handshake, both sides have `CipherState` objects with:
- a symmetric key (32 bytes, derived from handshake)
- a nonce counter (starts at 0, increments per message)

encryption: ChaChaPoly1305(key, nonce_counter, plaintext)
the nonce is the counter encoded as 12-byte little-endian (padded with zeros).

ChaChaPoly is chosen over AES-GCM because:
- constant-time without hardware support (relevant for WebAssembly)
- no IV management concerns (counter mode is deterministic)
- widely used in Noise implementations (WireGuard, Lightning)

### implementation

location: `packages/zid/src/noise-channel.ts` (new file, replaces channel.ts)

dependencies:
- `@noble/ciphers` for chacha20poly1305
- `@noble/curves/ed25519` for ed25519-to-x25519 conversion (edwardsToMontgomeryPub/Priv)
- `@noble/hashes` for HKDF/SHA-256 (Noise uses HKDF for key derivation)

no external Noise library. the IK pattern is ~200 lines of code. bringing in
a full Noise library adds unnecessary attack surface and dependency weight.
implement the state machine directly.

the handshake state machine:
```typescript
interface HandshakeState {
  s: { pub: Uint8Array; priv: Uint8Array }   // our static x25519
  e: { pub: Uint8Array; priv: Uint8Array }   // our ephemeral x25519
  rs: Uint8Array                              // remote static x25519
  re: Uint8Array | null                       // remote ephemeral (filled during handshake)
  ck: Uint8Array                              // chaining key (32 bytes)
  h: Uint8Array                               // handshake hash (32 bytes)
  initiator: boolean
}
```

after handshake completes, split into two `CipherState` objects (send/recv).
zeroize all handshake state.

### API change

```typescript
// before (raw DH)
const channel = await createChannel(session, peerPubkey, relayUrl)

// after (Noise IK) - same external API, different internals
const channel = await createNoiseChannel(session, peerPubkey, relayUrl)
```

the `ZidChannel` interface stays the same. callers don't change.

---

## 2. external encryption API

expose zafu's encryption to third-party web apps via the existing
`chrome.runtime.onMessageExternal` listener pattern (same as FROST/poker).

### sealed box (one-shot encryption)

for apps that just need to encrypt a blob for a known recipient:

```
zafu_encrypt { recipient: hex_ed25519_pubkey, plaintext: base64 }
  -> { ciphertext: base64, ephemeral_pubkey: hex }

zafu_decrypt { ciphertext: base64, ephemeral_pubkey: hex }
  -> { plaintext: base64 }
```

implementation: ephemeral x25519 keypair, DH with recipient's x25519 (derived
from their ed25519 pubkey), HKDF -> AES-256-GCM. the ephemeral pubkey is
prepended to the ciphertext so the recipient can recover the shared secret.

this is NaCl's `crypto_box_seal` pattern but using Web Crypto primitives.

### session channel

for apps that need ongoing encrypted communication:

```
zafu_channel_open { peer: hex_ed25519_pubkey, relay?: url }
  -> { channel_id: string }

zafu_channel_send { channel_id: string, data: base64 }
  -> { ok: true }

zafu_channel_on_message { channel_id: string }
  -> streams messages back via chrome.runtime.sendMessage to the app's tab

zafu_channel_close { channel_id: string }
  -> { ok: true }
```

the Noise handshake happens inside `zafu_channel_open`. the app never sees
key material. the `channel_id` is an opaque handle.

### permission model

- first time an origin calls any `zafu_encrypt`/`zafu_channel` API:
  approval popup, same UX as FROST approval
- after approval: origin is remembered for the session (cleared on lock)
- `zafu_encrypt` (one-shot) does NOT require per-message approval
- `zafu_channel_open` requires approval (establishes persistent connection)
- rate limit: max 100 encrypt/decrypt calls per minute per origin
- origins are scoped to ZID site-specific keys (no cross-origin correlation)

### location

handler: `apps/extension/src/message/listen/external-encryption.ts` (new file)
registered in `service-worker.ts` alongside the existing FROST/sign listeners.

---

## 3. on-chain channel bootstrapping

### the problem

to open a Noise channel, the initiator needs:
1. the responder's ZID pubkey
2. a relay URL where the responder will connect

for poker (both players are online), this is solved by the game lobby.
for async communication (inbox, DMs), we need a discovery mechanism.

### solution: shielded memo as Noise pre-handshake

penumbra and zcash memos are encrypted to the recipient. polkadot remarks
are public. we handle both.

#### memo payload format (fits in 512 bytes)

```
[4 bytes: magic "zNI\x01"]           -- "zafu Noise Init v1"
[32 bytes: initiator ed25519 pubkey]  -- so responder knows who's calling
[32 bytes: initiator ephemeral x25519 pubkey (Noise e)]
[2 bytes: relay URL length]
[N bytes: relay URL (UTF-8)]
[remaining: optional encrypted app payload]
```

the ephemeral key is the same `e` that will be used in the Noise IK handshake.
this means the initiator commits to the handshake before the memo is even
confirmed. the responder can complete the handshake immediately upon seeing
the memo, without an extra round trip.

#### flow

1. alice sends 0.001 PEN/ZEC to bob with memo containing Noise init
2. bob's wallet detects the `zNI\x01` magic in decrypted memo
3. bob's wallet auto-connects to the relay URL
4. bob's wallet completes the Noise IK handshake (using alice's `e` from memo)
5. channel is established. alice is notified via relay.

for polkadot: the remark payload is the same, but encrypted to bob's known
x25519 pubkey (derived from ZID) using a sealed box. the outer layer is
public, but the content is encrypted. this leaks that alice sent something
to bob, but not what.

#### auto-detection

in the zcash sync worker and penumbra view service, add a memo pattern
matcher:
```typescript
if (memoBytes.length >= 68 && memo[0..4] === 'zNI\x01') {
  // extract initiator pubkey, ephemeral key, relay URL
  // prompt user: "alice wants to open an encrypted channel"
  // if accepted: connect to relay, complete Noise handshake
}
```

---

## 4. group encryption (epochs)

### when pairwise noise isn't enough

a poker table with 6 players using pairwise Noise means 15 channels.
each message must be sent 5 times. this is fine for small groups but
does not scale.

for broadcast (game state, chat), we want a single group key that
all members share. MLS (RFC 9420) solves this with a ratchet tree,
but MLS is designed for groups of thousands. we need something simpler
for groups of 2-20.

### simplified epoch model

```
epoch_secret = HKDF-SHA256(
  IKM: sorted_concat(pairwise_noise_keys[]),
  salt: epoch_counter || group_id,
  info: "zafu-group-v1"
)

message_key[i] = HKDF-SHA256(
  IKM: epoch_secret,
  salt: message_counter,
  info: "zafu-group-msg"
)
```

each group member contributes their pairwise Noise session key to the
group secret. this means:
- all members must complete pairwise Noise handshakes first
- the group secret is only known to authenticated members
- if any member's pairwise session is compromised, the group secret
  must be rotated (new epoch)

### epoch transitions

a new epoch is triggered by:
- member join: new member establishes pairwise Noise with all existing members,
  all members re-derive group secret
- member leave: remaining members re-derive group secret without the
  departed member's contribution
- explicit rotation: any member can request a new epoch (PCS recovery)

epoch transitions are coordinated via a Commit message (similar to MLS but
simpler):
```
{
  type: "epoch",
  epoch: N+1,
  group_id: "...",
  members: [pubkey1, pubkey2, ...],
  psk_contributions: [encrypted_psk1, encrypted_psk2, ...],
  signature: "..." // signed by the committer
}
```

each member verifies the Commit, re-derives the epoch secret, and
deletes the old epoch keys (forward secrecy).

### when to upgrade to MLS

if groups exceed 20 members, the O(N^2) pairwise handshake cost becomes
significant. at that point, evaluate implementing the MLS ratchet tree
(O(log N) per operation). this is not expected for poker or FROST use cases.

---

## 5. services built on zafu encryption

### zid-relay

the relay we already have (poker.zk.bot) is a dumb WebSocket message router.
it needs zero changes to support Noise - it just forwards bytes between
`(from, to)` pairs. the only upgrade: support persistent mailbox mode where
messages are stored until the recipient connects (for async channel init).

### zid-mail

encrypted async mailbox. a thin HTTP service:
- `POST /box/{recipient_pubkey}` - store sealed box (encrypted to recipient)
- `GET /box/{my_pubkey}?sig={auth}` - retrieve my messages (auth = signed nonce)
- `DELETE /box/{my_pubkey}/{id}?sig={auth}` - delete after reading

the server stores opaque blobs. it knows recipient pubkeys (unavoidable for
routing) but not sender identity or content. rate-limited by proof of work
or ZEC micropayment.

### zid-paste

encrypted pastebin. client encrypts content, uploads ciphertext, gets a URL.
the decryption key is in the URL fragment (never sent to server).

```
https://paste.zk.bot/abc123#decryption_key_hex
```

optionally: encrypt to a specific ZID pubkey instead of a symmetric key.
then only the holder of that ZID can decrypt.

### @zafu/zid npm package

standalone library for apps that want ZID encryption without requiring
the zafu extension. the app provides key material directly:

```typescript
import { createIdentity, createChannel } from '@zafu/zid'

const identity = createIdentity(privateKeyHex)
const channel = await identity.channel(peerPubkey)
channel.send('hello')
```

same Noise IK implementation as the extension, just without the
chrome.runtime.sendMessage bridge.

---

## design principles

1. **zafu is the keystore, apps are the UI.** keys never cross the extension
   boundary. apps send plaintext in, get ciphertext out.

2. **noise IK for pairwise, simplified MLS for groups.** don't over-engineer.
   pairwise Noise is battle-tested (WireGuard, Lightning). group encryption
   uses a simple epoch model until scale demands the full MLS tree.

3. **the relay is a dumb pipe.** it routes bytes by (from, to) pubkey pairs.
   it cannot read content, forge messages, or correlate sessions (Noise hides
   the static keys from passive observers after the first handshake message).

4. **forward secrecy by default.** every Noise session uses ephemeral keys.
   compromise of a static key does not reveal past sessions. old epoch keys
   are deleted.

5. **identity-bound encryption.** every channel is authenticated by ZID
   signatures. you always know who you're talking to. for anonymity, use
   an ephemeral ZID (rotate identity, use once, discard).

6. **on-chain bootstrapping, off-chain communication.** shielded memos are
   the key discovery mechanism. the relay is the transport. the chain is
   never used for message content.

7. **cross-chain by construction.** ZID is ed25519. x25519 is derived from
   ed25519. this works regardless of which chain the identity was registered
   on. a zcash user can encrypt to a penumbra user can encrypt to a polkadot
   user.
