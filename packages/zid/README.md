# @zafu/zid

The zafu identity SDK for websites. Let a visitor **log in with their zafu wallet**, sign actions, open **post-quantum end-to-end-encrypted** channels, and encrypt messages to their contacts - without your site ever touching a private key.

```sh
npm install @zafu/zid
```

## Login with zafu

```ts
import { detect, zid } from '@zafu/zid';

// 1. is a compatible zafu wallet present? (decide what to render)
const found = await detect();
if (!found.installed) {
  // show an "install zafu" link
} else if (!found.compatible) {
  // wallet speaks a protocol this SDK doesn't - show "update zafu"
} else {
  // 2. connect: the wallet prompts the user to authorize this site
  const me = await zid.connect({ appName: 'poker.zafu.pro' });
  console.log(me.pubkey);      // the session identity (hex ed25519)
  console.log(me.mode);        // 'zafu' when wallet-backed, 'ephemeral' otherwise

  // 3. sign a server-issued challenge to prove control of the identity
  const sig = await me.sign(new TextEncoder().encode(serverNonce));
}
```

> **Server-side login:** have your server issue a fresh random nonce that also commits to your origin, ask the wallet to sign it, and verify the signature against `me.pubkey`. The wallet signs the exact bytes you pass, so binding origin + nonce into the challenge (SIWE-style) is what stops a signature being replayed on another site.

## Post-quantum encryption

Encrypt a message to another zafu user. `encryptFor` automatically uses their **hybrid X25519 + ML-KEM-768** key when their wallet advertises one, so recorded ciphertext stays confidential even against a future quantum computer (*harvest-now, decrypt-later*). It falls back to classical when the recipient's wallet is older.

```ts
import { detect, zidPubkey, encryptFor, decryptFrom } from '@zafu/zid';

const wallet = /* a ZafuHandle, e.g. from detect()/connect wiring */;

const recipient = await zidPubkey(wallet);            // { pubkey, pq_pubkey?, pq_suite? }
const sealed = await encryptFor(wallet, recipient, new TextEncoder().encode('gm'));
sealed.postQuantum; // true when the PQ path was used

const plaintext = await decryptFrom(wallet, sealed);  // Uint8Array
```

## Encrypted channels

`me.channel(peerPubkey)` opens a **hybrid post-quantum Noise IK** channel over a relay - the ML-KEM-768 secret is mixed into the handshake, and the ephemeral keys give forward secrecy:

```ts
const ch = await me.channel(peerPubkey);
ch.on('message', (bytes) => console.log(new TextDecoder().decode(bytes)));
ch.send('hello, privately');
```

## Contacts

In zafu mode, `me.pickContacts()` opens the wallet's contact picker and returns **app-scoped opaque handles** (unlinkable across apps) - your site never sees the user's social graph.

```ts
const picked = await me.pickContacts({ purpose: 'invite a friend', max: 1 });
// [{ handle, displayName }]
```

## Errors

Every call throws a typed [`ZafuError`](./src/errors.ts) with a `.code` you can branch on, instead of failing silently:

```ts
import { ZafuError } from '@zafu/zid';

try {
  await encryptFor(wallet, recipient, data);
} catch (e) {
  if (e instanceof ZafuError) {
    switch (e.code) {
      case 'unavailable':   // no wallet
      case 'locked':        // ask the user to unlock
      case 'denied':        // user declined
      case 'rate_limited':
      case 'incompatible':
      case 'transport_error':
    }
  }
}
```

## Transport

The SDK talks to the extension over a pluggable [`ZafuTransport`](https://www.npmjs.com/package/@zafu/protocol). `createExtensionTransport` is the default; swapping it (a relay, a native host) is how the same API reaches a wallet on another surface.

## License

MIT
