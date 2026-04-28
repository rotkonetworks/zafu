<div align="center">

# Zafu

A privacy-centric multichain wallet with client-side state.

</div>

## what

Zafu is a Chrome extension wallet built around two principles:

1. **Privacy is a first-class chain property.** Penumbra and Zcash are the
   production shielded chains with mature crypto, and Zafu is a first-class
   client for both. Other networks are supported as bridging infrastructure;
   the privacy chains are the organizing principle of the wallet, not items
   on a list.

2. **State is client-side.** Zafu does not depend on a custodial backend.
   Viewing keys live on the user's device, notes are decrypted locally, and
   transactions are built locally. Network calls go only to chain RPC
   endpoints - which can be self-hosted - for state and broadcast.

The recommended security posture pairs Zafu with
[Zigner](https://github.com/rotkonetworks/zigner), an air-gapped cold signer
running on a dedicated phone. Zafu holds only viewing keys, Zigner holds
spending keys, and the channel between them is QR codes only.

A standalone mode is available for users who don't want air-gap. In
standalone mode, spending keys are encrypted at rest with a passphrase and
held on the host browser.

## what it does

- **Penumbra** - shielded transfers, swaps, staking, delegated voting, IBC
- **Zcash** - Orchard pool send/receive, transparent (`t1…`) send/receive,
  shield-to-Orchard
- **Multisig** - t-of-n FROST vaults on both chains, with QR-based DKG and
  signing. See [docs/MULTISIG.md](docs/MULTISIG.md).
- **Hot/cold** - viewing-key-only mode that pairs with Zigner via QR

## privacy properties

| property                          | preserved |
|-----------------------------------|-----------|
| sender / receiver / amount        | yes (chain-level) |
| cross-tx linkability              | yes (chain-level) |
| view-only delegation              | yes (Zigner pairing) |
| forward secrecy on key leak       | no - chain history is permanent |
| metadata vs query backend         | no - run your own Zidecar / pd |
| host-process compromise           | depends on custody mode |

Full threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). For the
broader doc index, see [docs/README.md](docs/README.md).

## who this is not for

- users who want a 30-chain swiss-army wallet
- users who need cloud-synced transaction history
- users who can't or won't run a self-hosted query backend, if metadata
  privacy is in their threat model

## install

Beta: signed `.crx` builds on the
[releases page](https://github.com/rotkonetworks/zafu/releases). Current
version: `v24.0.0-beta.1`.

Production (Chrome Web Store): pending review.

## build

Requires Node.js 22+, pnpm (via corepack), and Chrome or Chromium. Or
`nix develop`.

```sh
git clone https://github.com/rotkonetworks/zafu
cd zafu
pnpm install
pnpm dev
```

Output lands in `apps/extension/dist`. Load it via `chrome://extensions` →
developer mode → "load unpacked".

For a dedicated browser profile:

```sh
CHROMIUM_PROFILE=chromium-profile pnpm dev
```

Production and beta bundles:

```sh
pnpm build
```

Outputs `apps/extension/dist` (prod, ID `bfdfeleokgpdladfmipfmffgpjfjibbe`)
and `apps/extension/beta-dist` (beta, ID
`hlnodmbpndgjbhophnfbnfpgcbogiohh`).

## monorepo

```
apps/
  extension/          chrome MV3 extension
packages/
  context/            shared react context
  custody-chrome/     key custody backed by chrome storage
  encryption/         passphrase-derived encryption helpers
  finagle/            internal utilities
  mock-chrome/        chrome API stubs for tests
  query/              chain query layer
  storage-chrome/     chrome storage abstraction
  ui/                 shared UI components
  wallet/             cross-chain wallet logic
  zcash-wasm/         zcash orchard derivation (WASM, rayon)
  zid/                zafu identity SDK
  tailwind-config/    shared tailwind preset
  tsconfig/           shared tsconfig presets
```

## upstream

Forked from [prax-wallet/prax](https://github.com/prax-wallet/prax). Penumbra
packages from [@penumbra-zone/web](https://github.com/penumbra-zone/web).

## license

[MIT](LICENSE-MIT) / [Apache-2.0](LICENSE-APACHE)
