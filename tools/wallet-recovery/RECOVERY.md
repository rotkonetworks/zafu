# zafu wallet disk recovery

Rebuild your seed phrase from a Chrome profile + your wallet password, using
**no zafu code and no server**. This is the "my Chrome broke but the profile is
intact" path.

> Your written seed-phrase backup remains the PRIMARY recovery - it survives a
> dead disk. This tool is the secondary path for when the profile files exist
> but the extension won't load.

## What you need

1. The wallet **password**.
2. A dump of the extension's `chrome.storage.local`, as JSON.

## Step 1 - get the storage dump

**Easiest (extension still loads):**

1. `chrome://extensions` -> enable Developer mode -> under zafu click **service worker** (inspect).
2. In the console:
   ```js
   chrome.storage.local.get(null).then(d => console.log(JSON.stringify(d)))
   ```
3. Copy the printed JSON into a file, e.g. `dump.json`.

The dump only contains the **encrypted** seed (salt + nonce + ciphertext) - it is
useless without the password.

**Advanced (dead profile, extension won't load):**

`chrome.storage.local` for an MV3 extension is a LevelDB at:

```
<chrome-profile>/Local Extension Settings/<extension-id>/    (*.ldb, *.log)
```

Close Chrome (LevelDB is locked while running), copy that folder, and read it
with any LevelDB reader (e.g. Node `classic-level`), then serialize the
key/values to the same JSON shape. The extension id is on `chrome://extensions`.

## Step 2 - recover

```
node recover.mjs dump.json
# prompts for the password (input hidden), prints each recovered seed
```

Non-interactive:

```
WALLET_RECOVERY_PASSWORD='...' node recover.mjs dump.json
```

Run it **offline, on a machine you trust** - the recovered seed is printed in
plaintext.

## The crypto (so you can reimplement it in any language)

Everything matches `packages/encryption`:

| field | value |
| --- | --- |
| KDF | `PBKDF2(password, salt, iterations=210000, hash=SHA-512)` |
| key | AES-GCM, 256-bit |
| salt | `passwordKeyPrint.salt`, 16 bytes, base64 |
| password check | `passwordKeyPrint.hash == SHA-256(raw key)`, base64 |
| box | `{ nonce: 12 bytes b64, cipherText: b64 }` (AES-GCM, nonce = IV) |
| seed | `AES-GCM-decrypt(cipherText, iv = nonce, key)` -> UTF-8 |

Encrypted seeds appear as `vaults[].encryptedData` (a stringified box) and
`penumbraWallets[].custody.encryptedSeedPhrase` (a box). `recover.mjs` finds
them recursively, so it keeps working across storage-schema changes.

## Caveats

- **Needs the disk blob AND the password** - the password alone is not enough.
- **A weak password is brute-forceable offline** once someone has the profile
  files. PBKDF2 (210k, SHA-512) is solid but not memory-hard; use a strong
  password. Moving the KDF to Argon2id is a worthwhile future hardening.
- Self-contained multisig backups carry their own keyprint and open with their
  own passphrase, not the master password - `recover.mjs` will skip those boxes.
