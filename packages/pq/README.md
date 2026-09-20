# @zafu/pq

Hybrid post-quantum key agreement for [zafu](https://zafu.pro) - **X25519 + ML-KEM-768** (X-Wing) plus a sealed box built on it. Thin, audited-primitive wrappers over [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers).

## Why

An adversary who records encrypted traffic **today** can decrypt it once a quantum computer exists (_harvest-now, decrypt-later_). Mixing ML-KEM-768 into key agreement keeps that recorded traffic confidential against a future quantum attacker - **now, while the data still matters**. It's always **hybrid**: X25519 stays in the mix, so a flaw in the (young) ML-KEM never lowers today's classical security. Both halves must break.

This is **confidentiality only** - KEMs for key agreement. Signatures stay classical (a verified signature has no harvest-now exposure).

## Install

```sh
npm install @zafu/pq
```

## X-Wing hybrid KEM

```ts
import { xwingKeypairFromSeed, xwingEncapsulate, xwingDecapsulate } from '@zafu/pq';

// the secret key IS a 32-byte seed -> derive it from your mnemonic and it is
// recoverable. pk 1216B, ct 1120B, shared secret 32B.
const bob = xwingKeypairFromSeed(seed32);
const { sharedSecret, cipherText } = xwingEncapsulate(bob.publicKey);
const same = xwingDecapsulate(cipherText, bob.secretKey); // === sharedSecret
```

## Sealed box (anonymous sender, one-shot)

```ts
import { sealXWing, openXWing, xwingKeypairFromSeed } from '@zafu/pq';

const bob = xwingKeypairFromSeed(seed32);
const wire = sealXWing(bob.publicKey, new TextEncoder().encode('hello'));
const msg = openXWing(seed32, wire); // throws on tamper / wrong key
```

X-Wing encapsulate → HKDF-SHA256 → AES-256-GCM, in a self-contained suite-tagged wire (the ephemeral is inside; no separate pubkey to carry).

## Raw ML-KEM-768

`mlkem768KeygenEphemeral` / `mlkem768KeypairFromSeed` / `mlkem768Encapsulate` / `mlkem768Decapsulate` - for protocols (like a hybrid Noise handshake) that already do their own X25519 and only need the ML-KEM shared secret mixed in.

## Notes

- **Implicit rejection**: a wrong or tampered ML-KEM ciphertext does not throw at `decapsulate` - it returns a pseudo-random secret that differs from the sender's. The mismatch must be caught downstream by AEAD decryption failing (the sealed box does this for you).
- Sizes exceed a 512-byte memo / 64-byte blob, so plan transport accordingly.

## License

MIT
