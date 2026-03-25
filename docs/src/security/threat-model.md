# threat model

## what zafu protects

zafu is designed to protect against:

1. **network observers** - all transactions use shielded pools (zcash orchard, penumbra). amounts, sender, recipient, and memo contents are hidden from anyone observing the network.

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
  network observers (shielded by zcash/penumbra)
  relay operators (if used - see encrypted blobs only)
```

## encryption at rest

| data | storage | encrypted |
|------|---------|-----------|
| penumbra wallets (FVK) | chrome.storage.local | yes (AES-256-GCM) |
| zcash wallets (UFVK) | chrome.storage.local | yes |
| contacts | chrome.storage.local | yes |
| messages | chrome.storage.local | yes |
| recent addresses | chrome.storage.local | yes |
| connected sites | chrome.storage.local | no (no private data) |
| password key | chrome.storage.session | session only |
| vaults (encrypted mnemonic) | chrome.storage.local | yes (separate key) |
