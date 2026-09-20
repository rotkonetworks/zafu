# threat model

## what zafu protects

zafu is designed to protect against:

1. **network observers** - transactions on the shielded chains (zcash orchard, penumbra) use shielded pools: amounts, sender, recipient, and memo contents are hidden from anyone observing the network. note that not every launched network is shielded - the noble/USDC path is a transparent public ledger (an IBC destination under penumbra), so activity there is not shielded.

2. **RPC server operators** - the extension connects to light client endpoints for compact blocks (public chain data). the server never sees your viewing keys, balances, or transaction history. the view server runs locally.

3. **device theft (locked state)** - wallet data is encrypted at rest with AES-256-GCM. viewing keys, zcash wallet data, contacts, and messages are stored as encrypted blobs in chrome.storage.local. the encryption key is derived from your password via PBKDF2-SHA512 (210,000 iterations) and exists only in chrome.storage.session while unlocked.

4. **website tracking** - per-site zid identities prevent cross-site correlation. websites only see the zid derived for their specific origin.

5. **contact forwarding** - per-contact zid identities let you detect when someone shares your contact information with a third party.

## what zafu does not protect against

1. **compromised device** - if your device is compromised (malware, root access), an attacker can read memory, intercept keystrokes, and extract keys. zafu cannot protect against a compromised operating system.

2. **compromised browser** - chrome extensions run inside the browser's process. a compromised browser can read extension memory. use a hardened browser configuration.

3. **viewing key compromise (unlocked state)** - while the wallet is unlocked, viewing keys are in memory. a memory dump could extract them. zid-encrypted messages provide an additional layer (the attacker would need both the viewing key and the zid private key).

4. **mnemonic compromise** - if your seed phrase is compromised, all derived keys (spending, viewing, zid) are compromised. use zigner for air-gapped key storage.

5. **side-channel attacks** - WASM proving runs in the browser. timing side channels may leak information about transaction values or key material. this is an inherent limitation of browser-based cryptography.

6. **cross-chain swap custody** - the cross-chain ZEC swap routes through NEAR Intents (Defuse / 1Click), a third-party service zafu does not operate or control. funds are sent to a deposit address returned by that service, which may be a custodial address rather than a trustless bridge. those funds may be delayed, held, frozen, or subject to the service's own compliance review, and cannot be recovered or guaranteed by zafu. the swap UI discloses this and requires the user to acknowledge it before committing funds. swap details are shared with the third-party API.

## trust boundaries

```
trusted:
  your device (assuming not compromised)
  the extension code (open source, auditable)
  the WASM proving libraries

partially trusted:
  chrome browser (sandboxing, extension isolation)
  light client RPC endpoint (sees your IP, knows you use zafu)

untrusted:
  websites / dapps (sandboxed by extension transport)
  network observers (shielded on zcash/penumbra; transparent on noble/USDC)
  frost multisig relay (Noise_K ciphertext + session metadata only)
  zid direct-message / call relay (E2EE payloads + metadata only)
  zitadel public-chat relay (sees room messages in cleartext - see below)
  cross-chain swap service (1Click/NEAR Intents - may custody deposited funds)
```

### relays and chat

zafu uses several relays; each sees a different amount.

- **frost multisig relay (frostd)**: transports DKG and signing messages, which
  are Noise_K encrypted end-to-end. it sees ciphertext and session metadata, not
  keys, amounts, or recipients. see [frost](frost.md).
- **zid direct messages and calls**: DMs use a Noise IK channel between two ZID
  keypairs, and voice/video call setup rides the same end-to-end encrypted
  channel (media is then direct peer-to-peer, which reveals your IP to the peer).
  the channel handshake is hybrid post-quantum (see below).
- **zitadel public chat**: public rooms are **not** encrypted - messages are
  cleartext to the relay and anyone it forwards them to. messages and nicknames
  are ed25519-signed for authenticity, so the relay cannot forge them, but it
  can read them. do not put anything private in a public room.

### post-quantum identity layer

the zid messaging channel (DMs and call setup) is hybrid post-quantum: the Noise
IK handshake mixes ML-KEM-768 into the classical X25519 key agreement, so the
transport stays secure even if X25519 is later broken. `@zafu/pq` also provides
an X-Wing hybrid KEM (X25519 + ML-KEM-768) for one-shot sealed boxes. this is
confidentiality-only and defends against harvest-now-decrypt-later capture.
signatures and the ed25519 ZID identity remain classical - authentication has no
long-term decryption exposure.

## encryption at rest

| data                        | storage                | encrypted            |
| --------------------------- | ---------------------- | -------------------- |
| penumbra wallets (FVK)      | chrome.storage.local   | yes (AES-256-GCM)    |
| zcash wallets (UFVK)        | chrome.storage.local   | yes                  |
| frost multisig key packages | chrome.storage.local   | yes (in zcashWallets)|
| contacts                    | chrome.storage.local   | yes                  |
| messages                    | chrome.storage.local   | yes                  |
| group chats                 | chrome.storage.local   | yes                  |
| recent / diversified addrs  | chrome.storage.local   | yes                  |
| connected sites             | chrome.storage.local   | no (no private data) |
| frost relay identities      | chrome.storage.local   | no (not a spend key) |
| password key                | chrome.storage.session | session only         |
| vaults (encrypted mnemonic) | chrome.storage.local   | yes (separate key)   |
