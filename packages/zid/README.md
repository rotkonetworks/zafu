# @zafu/zid

The zafu identity SDK for websites. Let a visitor **log in with their zafu wallet**, sign server challenges, encrypt messages with **post-quantum** protection, and open end-to-end-encrypted channels - without your site ever touching a private key.

```sh
npm install @zafu/zid
```

## Quick start: a "Log in with zafu" button

```ts
import { connect, ZafuError } from '@zafu/zid';

button.onclick = async () => {
  try {
    const me = await connect({
      appName: 'My App',
      requireWallet: true,
      onWaiting: () => (button.textContent = 'Approve in zafu...'),
    });
    console.log('signed in as', me.pubkey);
  } catch (e) {
    if (e instanceof ZafuError) showError(e.code); // 'unavailable' | 'denied' | 'locked' ...
  }
};
```

That is the whole integration. What it handles for you:

- **Double clicks.** A second `connect()` while zafu is still asking the user joins the first request. The wallet never gets two approvals.
- **Slow approvals.** Nothing times out while the user unlocks or reads the request. Pass `onStatus` to see `waiting`, then `slow` after 15s (a good moment to say "click the zafu icon in your toolbar"), then `done` or `failed`.
- **Honest outcomes.** A declined or locked wallet throws a `ZafuError` with a code you can show (see [Errors](#errors)). It never quietly hands you a different identity.
- **Where the approval appears** (side panel or popup window) is the user's setting in zafu. Your app doesn't choose it.

Drop `requireWallet: true` to get a guest identity instead of an error when zafu is not installed (see [section 6](#6-works-without-the-wallet-guest-identity)).

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

## 6. Works without the wallet (guest identity)

If no zafu wallet is installed, `zid.connect()` returns a **guest** identity
instead of failing (pass `requireWallet: true` to get `ZafuError('unavailable')`
instead). A guest is only ever returned when there is no wallet: if zafu is
installed and the request fails (declined, locked), `connect()` throws. It is not a degraded mode: from one in-page seed it derives
an ed25519 identity _and_ an X-Wing (X25519 + ML-KEM-768) key, so the same calls
work with or without the wallet.

```ts
const me = await zid.connect(); // wallet if present, guest otherwise

const keys = me.keys?.(); // { pubkey, pq_pubkey, pq_suite, pq_sig, pq_epoch, origin }
const sealed = await me.sealFor?.(theirKeys, bytes); // post-quantum sealed box
const opened = await me.openSealed?.(sealed); // Uint8Array
const ch = await me.channel(theirPubkey); // hybrid post-quantum channel by default
```

- `keys()` mirrors `zidPubkey()`, and `sealFor` / `openSealed` mirror
  `encryptFor` / `decryptFrom` (same field names, bytes instead of the wallet
  wire's base64/hex). `sealFor`/`openSealed` are present in `mode: 'zafu'` too and
  delegate to the wallet, so the call site does not change with the backend.
- `channel(peerPubkey)` uses the **hybrid** post-quantum Noise IK channel. The
  handshake is the caller's choice via `zid.connect({ channel })`:

  | `channel`            | behaviour                                                                                                                        |
  | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
  | `'hybrid'` (default) | post-quantum Noise IK only; fails closed, never downgrades                                                                       |
  | `'classical'`        | the legacy X25519 + AES-GCM channel                                                                                              |
  | `'auto'`             | try hybrid, fall back to classical **only when the handshake failed**; a transport failure (relay down, socket error) propagates |

  The channel you get carries `kind: 'hybrid' | 'classical'`, so an `'auto'`
  caller can see and refuse a downgrade instead of being told nothing;
  `isNoiseHandshakeFailure(err)` is the same test the fallback uses.

  **A peer still on `@zafu/zid@0.1.0` speaks only the classical handshake.** The
  hybrid handshake fails closed against it (different protocol name, never a
  downgrade), so a default-mode call to such a peer will not open. Reach it with
  `{ channel: 'classical' }`, or `{ channel: 'auto' }` to accept the downgrade
  knowingly. There is no silent fallback in either direction.

- The post-quantum prekey is authenticated exactly as on the wallet path: a
  recipient that advertises `pq_pubkey` must carry a valid `pq_sig`, or `sealFor`
  refuses rather than silently downgrading.

**Custody - read this.** The guest is burner-grade. By default the seed lives in
memory for the page and is gone on reload. `zid.connect({ persist: 'local' })`
stores it in `localStorage` so the identity survives reloads - still no backup,
no recovery, and readable by any script on the origin. Treat it as a throwaway
handle, not the user's keys.

### Contact discovery without the wallet

The guest derives its own contact card (`suite: 'x25519-v1'`) and the pairwise
root secret locally, then rides the same relay path as the wallet:

```ts
const me = await zid.connect({ relayEndpoint: 'https://relay.example/zid' });

me.contactCard?.(); // hand this to a peer
me.deriveRootSecret?.(peerCard); // pairwise secret from a card
me.establishSecret?.(peerPubkey); // or: establish once for a stored contact
const present = await me.discover?.(peers); // DiscoveredContact[]
```

`createHttpRelayTransport({ endpoint, fetch?, headers? })` is the HTTP relay
client; its module doc is the exact wire contract a server must implement. The
server MUST return the whole bucket for a coordinate and MUST NOT offer per-tag
lookup - that invariant _is_ the privacy property.

### Composition (services & filters)

zid's seams are also `Service`s, so they compose with `@zafu/service` the way
[`docs/services-pattern.md`](https://github.com/rotkonetworks/zafu/blob/main/docs/services-pattern.md)
describes (Eriksen, "Your Server as a Function"):

```ts
import { compose, retry, timeout, trace } from '@zafu/service';
import { walletService, walletStrategy, channelService, sealingFilter } from '@zafu/zid';

// a named, pre-composed stack around the wallet I/O leaf:
const wallet = walletStrategy('patient')(walletService(transport)); // trace + timeout + retry

const send = channelService(channel); // Service<Uint8Array, void>

// an end-to-end encrypted request path over any byte service:
const encrypted = compose(
  trace({ onComplete: log }),
  timeout(5_000),
  sealingFilter(keys), // seals the request, opens the sealed response
  retry({ attempts: 3 }),
)(relayService);
```

`compose` is left-to-right with the first-listed filter outermost, and filters
never change request/response shapes. Note `channelService`/`callSignalService`
resolve when a frame is _handed_ to the transport - `ZidChannel.send` is
fire-and-forget, so there is no delivery ack to await.

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

| Function                                                   | Purpose                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detect(zafu?)`                                            | Feature-detect + version-negotiate. Never throws; returns `{ installed, compatible, walletVersion, protocolVersion, protocolVersions }`.                                                                                                       |
| `detectZafu()`                                             | Return the raw wallet handle (or `null`), without throwing - the low-level counterpart to `requireWallet`.                                                                                                                                     |
| `requireWallet(zafu?)`                                     | Resolve a compatible wallet handle, or throw `ZafuError('unavailable' \| 'incompatible')`.                                                                                                                                                     |
| `sign(wallet, challengeHex, statement?)`                   | Sign a challenge with the site-scoped ZID ed25519 key → `{ signature, publicKey }`.                                                                                                                                                            |
| `signBytes(wallet, bytes, statement?)`                     | As `sign`, hex-encoding the bytes for you.                                                                                                                                                                                                     |
| `zidPubkey(wallet)`                                        | **Your** site-scoped keys → `{ pubkey, pq_pubkey?, pq_suite? }`.                                                                                                                                                                               |
| `encryptFor(wallet, recipient, bytes, opts?)`              | Seal to a recipient's keys (auto post-quantum) → `{ ciphertext, ephemeral_pubkey, postQuantum }`. `opts.requirePq` fails closed if the PQ path wasn't used.                                                                                    |
| `decryptFrom(wallet, sealed)`                              | Open a sealed box addressed to you → `Uint8Array`.                                                                                                                                                                                             |
| `zid.connect(opts?)`                                       | Authorize a session → `me` with `channel()`, `pickContacts()`, `sign()`. In `mode: 'ephemeral'` (no wallet) `me` also carries `keys()`, `sealFor()`, `openSealed()`, `contactCard()`, `deriveRootSecret()`, `establishSecret()`, `discover()`. |
| `createGuestIdentity(opts)`                                | Build the ephemeral (no-wallet) identity directly: same crypto surface, from one in-page seed.                                                                                                                                                 |
| `openChannel(session, peerPubkey, relayUrl, mode?)`        | Open a channel: `mode` is `'hybrid'` (default) \| `'classical'` \| `'auto'`; `'auto'` falls back only on a failed handshake and labels the result via `channel.kind`.                                                                          |
| `isNoiseHandshakeFailure(err)`                             | Whether a failure was a hybrid HANDSHAKE failure (the only kind `'auto'` downgrades on) rather than a transport failure.                                                                                                                       |
| `createHttpRelayTransport({ endpoint, fetch?, headers? })` | `RelayTransport` over HTTP for contact discovery; the module doc is the server wire contract.                                                                                                                                                  |
| `walletService(transport)` / `walletStrategy(name)`        | The wallet as a `Service<WalletRequest, WalletResponse>`, and a named filter stack (`'default'` \| `'patient'`) around it.                                                                                                                     |
| `channelService(channel)`                                  | Sending on a `ZidChannel` as a `Service<Uint8Array, void>`.                                                                                                                                                                                    |
| `sealingFilter(keys)`                                      | A `Filter` that seals the request with `@zafu/pq` and opens the sealed response - an end-to-end encrypted request path over any byte service.                                                                                                  |

## Transport

The SDK talks to the extension over a pluggable [`ZafuTransport`](https://www.npmjs.com/package/@zafu/protocol). `createExtensionTransport` is the default; swapping it (a relay, a native host) is how the same API reaches a wallet on another surface.

## License

MIT
