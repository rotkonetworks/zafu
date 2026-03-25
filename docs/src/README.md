# zafu

zafu is a privacy wallet for zcash and penumbra. it runs as a chrome
extension with client-side proving, encrypted storage, and air-gapped
signing support.

## design principles

**privacy by default.** viewing keys are encrypted at rest. no network
connections are made until you opt in per network. no telemetry, no
analytics, no tracking.

**your keys, your device.** spending keys never leave your device. the
extension proves transactions locally using WASM (halo2 for zcash,
groth16/plonk for penumbra). with zigner, spending keys stay on a
separate air-gapped device.

**minimal trust.** the extension connects to light client endpoints for
chain data (compact blocks). it does not trust the server with any
private data. the view server runs locally in the service worker.

**cross-network identity.** zafu derives a persistent ed25519 identity
(zid) from your seed phrase. this identity works across all networks
and can be used for authentication, message signing, and encrypted
communication.

## features

- zcash shielded transactions (orchard)
- penumbra shielded transactions
- FROST threshold multisig for zcash
- zigner air-gapped signing via QR codes
- zid cross-network identity
- contact cards via shielded memos
- encrypted wallet storage (AES-256-GCM)
- side panel and popup modes

## networks

| network   | send | receive | sync | swap | stake |
|-----------|------|---------|------|------|-------|
| penumbra  | yes  | yes     | yes  | yes  | yes   |
| zcash     | yes  | yes     | yes  | -    | -     |

## source

zafu is free software released under the GPL-3.0 license.

- source: [github.com/rotkonetworks/zafu](https://github.com/rotkonetworks/zafu)
- zigner: [zigner.rotko.net](https://zigner.rotko.net)
- by: [rotko networks](https://rotko.net)
