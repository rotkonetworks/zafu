<div align="center">

# Zafu

**A privacy-first multichain wallet for Zcash and Penumbra.**

Shielded by default. Keys on your device. Spending keys never touch the browser.

[![Beta](https://img.shields.io/github/v/release/rotkonetworks/zafu?include_prereleases&sort=date&display_name=release&label=release&color=6E56CF)](https://github.com/rotkonetworks/zafu/releases/tag/beta)
[![CI](https://img.shields.io/github/actions/workflow/status/rotkonetworks/zafu/turbo-ci.yml?branch=main&label=CI)](https://github.com/rotkonetworks/zafu/actions/workflows/turbo-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](#install)
[![Website](https://img.shields.io/badge/web-zafu.pro-6E56CF)](https://zafu.pro)

[Website](https://zafu.pro) · [Install](#install) · [Getting started](#getting-started) · [Security model](#security-model) · [Zigner cold signer](https://github.com/rotkonetworks/zigner)

</div>

---

## Why Zafu

Most "privacy wallets" leak the two things that matter: your keys and your metadata.
Zafu is built so that neither has to leave your control.

1. **Privacy is a chain property, not a feature toggle.** Penumbra and Zcash are
   the production shielded chains with mature, audited cryptography, and Zafu is a
   first-class client for both - shielded by default, not as an opt-in mode. Other
   networks exist only as bridging infrastructure; the shielded chains are the
   organizing principle of the wallet.

2. **State is client-side. There is no backend to trust.** Viewing keys live on
   your device, notes are decrypted locally, transactions are built locally.
   Network calls go only to chain RPC endpoints - which you can self-host - to
   read state and broadcast. Zafu never sees your keys, your balance, or your
   history, because there is no "Zafu server" in the path.

3. **Spending keys never touch the browser.** The recommended posture pairs Zafu
   with [Zigner](https://github.com/rotkonetworks/zigner), an air-gapped cold
   signer on a dedicated phone. Zafu holds only viewing keys; Zigner holds the
   spending keys; the only channel between them is QR codes. A browser compromise
   cannot move your funds because the signing key is not there to steal.

If you don't want an air-gap, a standalone mode encrypts spending keys at rest
with a passphrase and keeps them on the host browser - a weaker posture, stated
plainly.

## What it does

- **Zcash** - Orchard and Ironwood (NU6.3) shielded send/receive, transparent
  (`t1…`) send/receive, shielding, Orchard→Ironwood migration, cold-signing and
  FROST multisig over QR.
- **Penumbra** - shielded transfers, swaps, staking, delegated voting, IBC.
- **Hot / cold** - viewing-key-only mode paired with Zigner over QR.
- **Multisig** - t-of-n FROST vaults on both chains, with QR-based DKG and
  signing. See [docs/MULTISIG.md](docs/MULTISIG.md).

## Install

Zafu is a Chrome / Chromium extension. It currently ships as a **continuous
beta** - that's the live, actively-updated build - so install the signed beta
directly; it takes about a minute. (A stable Chrome Web Store listing is in
preparation.)

### Zafu (browser extension)

1. Download the latest `zafu-beta-*.zip` from the
   [current beta release](https://github.com/rotkonetworks/zafu/releases/tag/beta)
   (the `beta` tag always points at the newest build).
2. Unzip it.
3. Open `chrome://extensions` and enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder.
5. Open the extension from the toolbar puzzle-piece menu (pin it for quick access).

> Every push to `main` refreshes this beta in place. A stable prod release and a
> one-click Chrome Web Store install are coming; until then, the beta is the way in.

### Zigner (air-gapped cold signer - recommended)

Zigner runs on a spare Android phone kept permanently offline. It holds your
spending keys and signs transactions by scanning QR codes - nothing else in, then
nothing but a signed transaction out.

- Download the latest `zigner-*.apk` from the
  [Zigner releases](https://github.com/rotkonetworks/zigner/releases/latest) and
  install it (you may need to allow installs from unknown sources).
- For the strongest posture: flash **GrapheneOS** on a Pixel and let Zigner use
  hardware-backed **StrongBox** key storage. A self-hosted **F-Droid** repo
  ([foss.rotko.net](https://foss.rotko.net)) is planned so you can install and
  update without sideloading.

## Getting started

1. **Install** the extension and open it from the toolbar.
2. **Create or import a wallet.** Generate a new seed, or restore from an existing
   mnemonic. Write the seed down offline - Zafu can't recover it for you, by design.
3. **(Recommended) Pair your Zigner.** Add a cold, viewing-only wallet in Zafu and
   scan the account QR shown by Zigner. Zafu now tracks balances and builds
   transactions; the spending keys stay on the air-gapped phone.
4. **Receive.** Show your shielded address (or its QR) and send yourself a small
   amount to confirm the wallet syncs.
5. **Send.** Build the transaction in Zafu → it shows a signing-request QR → scan
   it into Zigner → review and confirm on the air-gapped device → scan the signed
   result back into Zafu → broadcast. No spending key ever exists in the browser.

Standalone (no air-gap): at step 2, choose the passphrase-encrypted hot wallet;
signing then happens entirely in the extension.

## Security model

Zafu is explicit about what it does and does not protect. Nothing here is
security theater.

| Property                           | Preserved                            |
| ---------------------------------- | ------------------------------------ |
| sender / receiver / amount         | yes (chain-level shielding)          |
| cross-transaction linkability      | yes (chain-level shielding)          |
| spending key on browser compromise | yes, in cold mode - key is on Zigner |
| view-only delegation               | yes (Zigner pairing)                 |
| forward secrecy on key leak        | no - chain history is permanent      |
| metadata vs query backend          | no - run your own Zidecar / pd       |
| host-process compromise            | depends on custody mode              |

Full threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Broader doc
index: [docs/README.md](docs/README.md).

**Who this is not for:** people who want a 30-chain swiss-army wallet, cloud-synced
history, or a custodial "reset my password" recovery path. Zafu trades that
convenience away on purpose.

## Build from source

Requires Node.js 22+, pnpm (via corepack), and Chrome / Chromium. Or `nix develop`.

```sh
git clone https://github.com/rotkonetworks/zafu
cd zafu
pnpm install
pnpm dev          # build all, serve, watch and rebuild
```

Output lands in `apps/extension/dist`. Load it via `chrome://extensions` →
Developer mode → **Load unpacked**.

Dedicated browser profile:

```sh
CHROMIUM_PROFILE=chromium-profile pnpm dev
```

Production and beta bundles:

```sh
pnpm build
```

Outputs `apps/extension/dist` (prod) and `apps/extension/beta-dist` (beta).
Release process and signing model: [RELEASING.md](RELEASING.md).

## Monorepo

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
  zcash-wasm/         zcash Orchard/Ironwood derivation (WASM, rayon)
  zid/                zafu identity SDK
  tailwind-config/    shared tailwind preset
  tsconfig/           shared tsconfig presets
```

## Upstream

Forked from [prax-wallet/prax](https://github.com/prax-wallet/prax). Penumbra
packages from [@penumbra-zone/web](https://github.com/penumbra-zone/web).

## License

[MIT](LICENSE)
