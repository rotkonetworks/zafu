# @zafu/zid

The zafu identity SDK for websites. Let a visitor **log in with their zafu wallet**, sign server challenges, encrypt messages with **post-quantum** protection, and open end-to-end-encrypted channels - without your site ever touching a private key.

```sh
npm install @zafu/zid
```

## Two ways to use it

- **Functional helpers** (one-shot, typed errors) - `requireWallet()` gives you a `wallet` handle, then `sign`, `zidPubkey`, `encryptFor`, `decryptFrom` each do one thing and throw a typed `ZafuError` on failure. Best for **login** and **encrypting a message**.
- **Session object** - `zid.connect()` returns a `me` with `me.channel()` and `me.pickContacts()`. Best for a **live session**: real-time encrypted channels and the wallet's contact picker.

You can mix them. Most sites need only the functional helpers.

## 1. Detect (decide what to render)

`detect()` never throws - use it before showing any UI.

```ts
import { detect } from '@zafu/zid';

const d = await detect();
if (!d.installed)
  renderInstallLink(); // no zafu wallet
else if (!d.compatible)
  renderUpdatePrompt(); // wallet speaks a protocol this SDK doesn't
else renderLoginButton();
```

## 2. Log in with zafu

Server issues a fresh nonce, the wallet signs it, your server verifies the signature. `requireWallet()` returns a handle or throws `ZafuError('unavailable' | 'incompatible')`; `sign()` throws `ZafuError('denied' | 'locked' | ...)`.

```ts
import { requireWallet, sign } from '@zafu/zid';

const wallet = await requireWallet();

// challengeHex is a fresh, server-issued nonce (hex). See the security note below.
const { signature, publicKey } = await sign(wallet, challengeHex, 'Sign in to example.com');

// send { signature, publicKey } to your server; it verifies the ed25519 signature
// over the challenge bytes against publicKey, then treats publicKey as the account id.
```

- `publicKey` is **site-scoped**: the same user gets a stable pubkey on _your_ origin (use it as their account id) and a _different_ one on every other site - so identities are not linkable across sites.
- `signBytes(wallet, bytes, statement?)` is the same call if your challenge is raw bytes rather than hex.

> **Security (important):** the wallet signs **only the challenge bytes** - it does not bind your origin into the signature. So your server MUST issue a fresh random nonce that also commits to your origin/audience (SIWE-style), and never a static string. A signature over challenge `C` is valid at any site that presents the same `C`.

## 3. Post-quantum encryption

`encryptFor` automatically uses the recipient's **hybrid X25519 + ML-KEM-768** key when their wallet advertises one, so recorded ciphertext stays confidential even against a future quantum computer (_harvest-now, decrypt-later_); it falls back to classical for older wallets.

`zidPubkey(wallet)` returns **your own** site-scoped keys - publish them so others can encrypt to you. To encrypt _to_ someone, you need _their_ keys (their `zidPubkey` output, shared with you out of band).

```ts
import { requireWallet, zidPubkey, encryptFor, decryptFrom } from '@zafu/zid';

const wallet = await requireWallet();

// your keys - hand these to peers so they can message you:
const mine = await zidPubkey(wallet); // { pubkey, pq_pubkey?, pq_suite? }

// encrypt TO a peer using THEIR keys (obtained from them):
const sealed = await encryptFor(wallet, theirKeys, new TextEncoder().encode('gm'));
sealed.postQuantum; // true when the PQ path was used

// decrypt a message that was addressed to you:
const plaintext = await decryptFrom(wallet, sealed); // Uint8Array
// `sealed` is { ciphertext, ephemeral_pubkey } - pass both back to decrypt.
```

`sealed.postQuantum` reflects what the wallet actually did. To **refuse** sending anything the post-quantum path didn't cover (recipient has no PQ key, or their wallet is too old), pass `{ requirePq: true }` and `encryptFor` throws `ZafuError('not_available')` instead of falling back to classical:

```ts
await encryptFor(wallet, theirKeys, bytes, { requirePq: true }); // fail closed
```

## 4. Encrypted channels (session)

`zid.connect()` authorizes a session; `me.channel(peerPubkey)` opens a **hybrid post-quantum Noise IK** channel over a relay (ML-KEM-768 mixed into the handshake, ephemeral keys for forward secrecy).

```ts
import { zid } from '@zafu/zid';

const me = await zid.connect({ appName: 'example.com' });
const ch = await me.channel(peerPubkey);
ch.on('message', bytes => console.log(new TextDecoder().decode(bytes)));
ch.send('hello, privately');
```

## 5. Contacts (session)

`me.pickContacts()` opens the wallet's contact picker and returns **app-scoped opaque handles** (unlinkable across apps) - your site never sees the user's social graph. Handles are for display and identity, not encryption keys.

```ts
const picked = await me.pickContacts({ purpose: 'invite a friend', max: 1 });
// [{ handle, displayName }]
```

## Errors

Every functional helper throws a typed `ZafuError` with a `.code` you can branch on, instead of failing silently:

```ts
import { ZafuError } from '@zafu/zid';

try {
  const wallet = await requireWallet();
  await sign(wallet, challengeHex, 'Sign in');
} catch (e) {
  if (e instanceof ZafuError) {
    switch (e.code) {
      case 'unavailable': // no wallet reachable
      case 'incompatible': // wallet speaks a different protocol major
      case 'locked': // ask the user to unlock
      case 'denied': // user declined
      case 'rate_limited':
      case 'not_available': // feature disabled in wallet settings
      case 'transport_error': // could not reach the wallet
      case 'wallet_error': // anything else the wallet reported
    }
  }
}
```

## API

| Function                                      | Purpose                                                                                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect(zafu?)`                               | Feature-detect + version-negotiate. Never throws; returns `{ installed, compatible, walletVersion, protocolVersion, protocolVersions }`.                    |
| `detectZafu()`                                | Return the raw wallet handle (or `null`), without throwing - the low-level counterpart to `requireWallet`.                                                  |
| `requireWallet(zafu?)`                        | Resolve a compatible wallet handle, or throw `ZafuError('unavailable' \| 'incompatible')`.                                                                  |
| `sign(wallet, challengeHex, statement?)`      | Sign a challenge with the site-scoped ZID ed25519 key → `{ signature, publicKey }`.                                                                         |
| `signBytes(wallet, bytes, statement?)`        | As `sign`, hex-encoding the bytes for you.                                                                                                                  |
| `zidPubkey(wallet)`                           | **Your** site-scoped keys → `{ pubkey, pq_pubkey?, pq_suite? }`.                                                                                            |
| `encryptFor(wallet, recipient, bytes, opts?)` | Seal to a recipient's keys (auto post-quantum) → `{ ciphertext, ephemeral_pubkey, postQuantum }`. `opts.requirePq` fails closed if the PQ path wasn't used. |
| `decryptFrom(wallet, sealed)`                 | Open a sealed box addressed to you → `Uint8Array`.                                                                                                          |
| `zid.connect(opts?)`                          | Authorize a session → `me` with `channel()`, `pickContacts()`, `sign()`.                                                                                    |

## Transport

The SDK talks to the extension over a pluggable [`ZafuTransport`](https://www.npmjs.com/package/@zafu/protocol). `createExtensionTransport` is the default; swapping it (a relay, a native host) is how the same API reaches a wallet on another surface.

## License

MIT
